import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { fromIni } from '@aws-sdk/credential-providers';
import { config } from '../config.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logError, logInfo, logWarn } from '../util/logger.js';
import { resolveExecutablePath, run, runOrThrow } from '../util/run.js';

export type LoginState = 'idle' | 'pending' | 'succeeded' | 'failed';

interface DeviceCodeInfo {
  message: string;
  verificationUrl?: string;
  userCode?: string;
}

interface AwsLoginDiagnostics {
  lastAwsCandidate?: string;
}

export interface AwsIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface EksCluster {
  name: string;
  region: string;
  arn?: string;
  endpoint?: string;
  status?: string;
  version?: string;
}

interface AwsExecOptions {
  env?: Record<string, string>;
  region?: string;
}

export interface AwsSsoProfileConfig {
  profileName: string;
  ssoSessionName?: string;
  ssoStartUrl: string;
  ssoRegion: string;
  accountId: string;
  roleName: string;
  region: string;
  output?: string;
}

export interface AwsStaticProfileConfig {
  profileName: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  output?: string;
}

export interface AwsRoleProfileConfig {
  profileName: string;
  roleArn: string;
  region: string;
  output?: string;
  sourceProfileName?: string;
  credentialSource?: 'Environment' | 'Ec2InstanceMetadata' | 'EcsContainer';
  roleSessionName?: string;
}

interface AwsProfileSelection {
  profile: string;
  configPath?: string;
  reason: string;
}

async function readTextIfExists(filePath?: string): Promise<string> {
  if (!filePath) return '';
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseAwsConfigProfiles(configText: string): Map<string, Record<string, string>> {
  const profiles = new Map<string, Record<string, string>>();
  let currentProfile: string | null = null;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim();
      const profileMatch = sectionName.match(/^profile\s+(.+)$/i);
      if (profileMatch) {
        currentProfile = profileMatch[1].trim();
        if (!profiles.has(currentProfile)) profiles.set(currentProfile, {});
      } else if (sectionName.startsWith('sso-session ')) {
        currentProfile = null;
      } else {
        currentProfile = sectionName;
        if (!profiles.has(currentProfile)) profiles.set(currentProfile, {});
      }
      continue;
    }

    if (!currentProfile) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim().toLowerCase();
    const value = line.slice(eqIndex + 1).trim();
    const current = profiles.get(currentProfile) ?? {};
    current[key] = value;
    profiles.set(currentProfile, current);
  }

  return profiles;
}

function readAwsIniProfilesSync(filePath?: string): Map<string, Record<string, string>> {
  if (!filePath) return new Map<string, Record<string, string>>();
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseAwsConfigProfiles(text);
  } catch {
    return new Map<string, Record<string, string>>();
  }
}

function hasAwsSsoSettings(profileSettings: Record<string, string>): boolean {
  return Boolean(
    profileSettings.sso_session ||
    profileSettings.sso_start_url ||
    profileSettings.sso_region,
  );
}

async function resolveAwsLoginProfile(env: Record<string, string>, preferredProfile: string): Promise<AwsProfileSelection> {
  const configPath = env.AWS_CONFIG_FILE || process.env.AWS_CONFIG_FILE; // || path.join(os.homedir(), '.aws', 'config');
  const configText = await readTextIfExists(configPath);
  const profiles = parseAwsConfigProfiles(configText);

  const preferredSettings = profiles.get(preferredProfile);
  if (preferredSettings && hasAwsSsoSettings(preferredSettings)) {
    return { profile: preferredProfile, configPath, reason: 'preferred profile has SSO settings' };
  }

  for (const [profile, settings] of profiles.entries()) {
    if (hasAwsSsoSettings(settings)) {
      return { profile, configPath, reason: `selected SSO-enabled profile ${profile}` };
    }
  }

  return {
    profile: preferredProfile,
    configPath,
    reason: preferredSettings ? 'preferred profile is not SSO-enabled' : 'no configured AWS profile found',
  };
}

export async function writeAwsSsoProfileConfig(filePath: string, config: AwsSsoProfileConfig): Promise<void> {
  const profileName = config.profileName.trim();
  const sessionName = (config.ssoSessionName?.trim() || profileName || 'default-sso').replace(/\s+/g, '-');
  const normalizedOutput = (config.output?.trim() || 'json').toLowerCase();
  const sections = [
    `[profile ${profileName}]`,
    `sso_session = ${sessionName}`,
    `sso_account_id = ${config.accountId.trim()}`,
    `sso_role_name = ${config.roleName.trim()}`,
    `region = ${config.region.trim()}`,
    `output = ${normalizedOutput}`,
    '',
    `[sso-session ${sessionName}]`,
    `sso_region = ${config.ssoRegion.trim()}`,
    `sso_start_url = ${config.ssoStartUrl.trim()}`,
    'sso_registration_scopes = sso:account:access',
    '',
  ];

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, sections.join('\n'), { encoding: 'utf8' });
}

export async function writeAwsStaticProfileConfig(
  configFilePath: string,
  credentialsFilePath: string,
  config: AwsStaticProfileConfig,
): Promise<void> {
  const profileName = config.profileName.trim();
  const normalizedOutput = (config.output?.trim() || 'json').toLowerCase();
  const configSections = [
    `[profile ${profileName}]`,
    `region = ${config.region.trim()}`,
    `output = ${normalizedOutput}`,
    '',
  ];
  const credentialSections = [
    `[${profileName}]`,
    `aws_access_key_id = ${config.accessKeyId.trim()}`,
    `aws_secret_access_key = ${config.secretAccessKey.trim()}`,
  ];

  if (config.sessionToken?.trim()) {
    credentialSections.push(`aws_session_token = ${config.sessionToken.trim()}`);
  }
  credentialSections.push('');

  await fsp.mkdir(path.dirname(configFilePath), { recursive: true });
  await fsp.mkdir(path.dirname(credentialsFilePath), { recursive: true });
  await fsp.writeFile(configFilePath, configSections.join('\n'), { encoding: 'utf8' });
  await fsp.writeFile(credentialsFilePath, credentialSections.join('\n'), { encoding: 'utf8' });
}

export async function writeAwsRoleProfileConfig(filePath: string, config: AwsRoleProfileConfig): Promise<void> {
  const profileName = config.profileName.trim();
  const normalizedOutput = (config.output?.trim() || 'json').toLowerCase();
  const sections = [
    `[profile ${profileName}]`,
    `role_arn = ${config.roleArn.trim()}`,
  ];

  const sourceProfileName = config.sourceProfileName?.trim();
  const credentialSource = config.credentialSource?.trim();
  if (sourceProfileName) {
    sections.push(`source_profile = ${sourceProfileName}`);
  } else if (credentialSource) {
    sections.push(`credential_source = ${credentialSource}`);
  } else {
    sections.push('credential_source = Ec2InstanceMetadata');
  }

  if (config.roleSessionName?.trim()) {
    sections.push(`role_session_name = ${config.roleSessionName.trim()}`);
  }

  sections.push(`region = ${config.region.trim()}`);
  sections.push(`output = ${normalizedOutput}`);
  sections.push('');

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, sections.join('\n'), { encoding: 'utf8' });
}

async function buildAwsCandidates(): Promise<string[]> {
  if (process.platform !== 'win32') return ['aws'];

  const candidates: string[] = [];
  const cliFromEnv = process.env.AWS_CLI_PATH?.trim();
  if (cliFromEnv) candidates.push(cliFromEnv);

  const knownRoots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    'C:\\Program Files (x86)',
    'C:\\Program Files',
  ].filter(Boolean) as string[];

  for (const root of knownRoots) {
    const awsExe = path.join(root, 'Amazon', 'AWSCLIV2', 'aws.exe');
    try {
      await fsp.access(awsExe);
      candidates.push(awsExe);
    } catch {
      // ignore
    }
  }

  candidates.push('aws.exe', 'aws', 'aws.cmd', 'aws.bat');
  return Array.from(new Set(candidates));
}

let cmdExeCache: string | null = null;

function resolveCmdExe(): string {
  if (cmdExeCache) return cmdExeCache;

  const comSpec = process.env.ComSpec?.trim();
  if (comSpec) {
    try {
      if (fs.existsSync(comSpec)) {
        cmdExeCache = comSpec;
        return cmdExeCache;
      }
    } catch {
      // Fall through to next candidate
    }
  }

  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'cmd.exe');
    try {
      if (fs.existsSync(candidate)) {
        cmdExeCache = candidate;
        return cmdExeCache;
      }
    } catch {
      // Fall through to default
    }
  }

  cmdExeCache = 'C:\\Windows\\System32\\cmd.exe';
  return cmdExeCache;
}

/**
 * Manages interactive `aws sso login --use-device-code` and surfaces the
 * verification URL + code while the CLI keeps polling in the background.
 */
export class AwsLoginManager {
  private proc: ChildProcess | null = null;
  private state: LoginState = 'idle';
  private lastMessage = '';
  private deviceInfo: DeviceCodeInfo | null = null;
  private diagnostics: AwsLoginDiagnostics = {};
  private readonly envProvider: () => Record<string, string>;

  constructor(envProvider: () => Record<string, string>) {
    this.envProvider = envProvider;
  }

  getStatus() {
    return {
      state: this.state,
      message: this.lastMessage,
      deviceInfo: this.deviceInfo,
      diagnostics: this.diagnostics,
    };
  }

  start(): Promise<DeviceCodeInfo> {
    if (this.state === 'pending') {
      return Promise.resolve(this.deviceInfo ?? { message: this.lastMessage });
    }

    this.state = 'pending';
    this.lastMessage = 'Starting AWS login...';
    this.deviceInfo = null;
    this.diagnostics = {};

    return new Promise((resolve) => {
      void (async () => {
        const env = this.envProvider();
        const requestedProfile = env.AWS_PROFILE || process.env.AWS_PROFILE || 'default';
        const selection = await resolveAwsLoginProfile(env, requestedProfile);
        const profile = selection.profile;
        const awsLoginArgs = ['sso', 'login', '--use-device-code', '--no-browser', '--profile', profile];
        const awsCandidates = await buildAwsCandidates();

      if (!selection.reason.includes('SSO-enabled profile') && selection.reason !== 'preferred profile has SSO settings') {
        this.state = 'failed';
        this.lastMessage =
          'No AWS SSO profile is configured for this session. Run aws configure sso for the profile stored in ' +
          `${selection.configPath ?? 'your AWS config file'}, then retry.`;
        this.diagnostics.lastAwsCandidate = awsCandidates[0];
        logCommandOutcome('error', 'aws.login.config.invalid', 'failed', 'aws', awsLoginArgs, {
          profile,
          requestedProfile,
          awsConfigFile: selection.configPath,
          candidateCommands: awsCandidates,
          commandLine: commandLine('aws', awsLoginArgs),
          reason: selection.reason,
        }, 'AWS login configuration is missing an SSO-enabled profile');
        resolve({ message: this.lastMessage });
        return;
      }

      if (profile !== requestedProfile) {
        this.lastMessage = `Using AWS SSO profile ${profile}.`;
      }

      let candidateIndex = 0;
      let watchdog: NodeJS.Timeout | null = null;
      let sawDeviceCode = false;
      let outputBuffer = '';

      const parseDeviceInfo = (): void => {
        const urlMatch = outputBuffer.match(/https?:\/\/\S+/i);
        const codeMatch =
          outputBuffer.match(/enter\s+(?:the\s+)?code\s+([A-Z0-9-]+)/i) ??
          outputBuffer.match(/code\s*[:=]\s*([A-Z0-9-]{4,})/i) ??
          outputBuffer.match(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b/i);

        if (urlMatch || codeMatch) {
          sawDeviceCode = true;
          if (watchdog) clearTimeout(watchdog);
          this.deviceInfo = {
            message: this.lastMessage || 'AWS device code received.',
            verificationUrl: urlMatch?.[0],
            userCode: codeMatch?.[1],
          };
        }
      };

      const handle = (chunk: Buffer) => {
        const text = chunk.toString();
        const trimmed = text.trim();
        if (trimmed) this.lastMessage = trimmed;
        outputBuffer = `${outputBuffer}${text}`;
        if (outputBuffer.length > 4096) outputBuffer = outputBuffer.slice(-4096);
        parseDeviceInfo();
      };

      const trySpawn = () => {
        const cmd = awsCandidates[candidateIndex];
        if (!cmd) {
          this.state = 'failed';
          this.lastMessage = 'AWS CLI executable not found. Install AWS CLI and ensure aws is on PATH.';
          if (watchdog) clearTimeout(watchdog);
          return;
        }

        this.diagnostics.lastAwsCandidate = cmd;
        const resolvedExecutablePath = resolveExecutablePath(cmd, {
          PATH: process.env.PATH ?? '',
          Path: process.env.Path ?? '',
        });

        logInfo('aws.login.exec.start', {
          cmd,
          executablePath: resolvedExecutablePath,
          commandPath: cmd,
          resolvedExecutablePath,
          args: awsLoginArgs,
          candidateIndex,
          candidateCommands: awsCandidates,
          commandLine: commandLine(cmd, awsLoginArgs),
          platform: process.platform,
          awsProfile: profile,
          awsConfigFile: env.AWS_CONFIG_FILE,
          awsCredentialsFile: env.AWS_SHARED_CREDENTIALS_FILE,
        });

        const isWindowsScript =
          process.platform === 'win32' && (cmd.toLowerCase().endsWith('.cmd') || cmd.toLowerCase().endsWith('.bat'));

        let child: ChildProcess;
        try {
          if (isWindowsScript) {
            child = spawn(resolveCmdExe(), ['/d', '/c', cmd, ...awsLoginArgs], {
              env: { ...process.env, ...env },
              shell: false,
              windowsHide: true,
            });
          } else {
            child = spawn(cmd, awsLoginArgs, {
              env: { ...process.env, ...env },
              shell: false,
              windowsHide: true,
            });
          }
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if ((e.code === 'ENOENT' || e.code === 'EINVAL') && candidateIndex < awsCandidates.length - 1) {
            logError('aws.login.exec.spawn_fallback', {
              cmd,
              executablePath: resolvedExecutablePath,
              commandPath: cmd,
              resolvedExecutablePath,
              candidateCommands: awsCandidates,
              fallbackExecutablePath: awsCandidates[candidateIndex + 1] ?? null,
              code: e.code,
            });
            candidateIndex += 1;
            trySpawn();
            return;
          }

          this.state = 'failed';
          this.lastMessage = `Failed to start aws: ${e.message}`;
          logCommandOutcome('error', 'aws.login.exec.spawn_failed', 'failed', cmd, awsLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            candidateCommands: awsCandidates,
            commandLine: commandLine(cmd, awsLoginArgs),
            code: e.code,
            message: e.message,
          }, commandReason(e));
          if (watchdog) clearTimeout(watchdog);
          return;
        }

        this.proc = child;
        this.lastMessage = 'Waiting for AWS device code...';

        watchdog = setTimeout(() => {
          if (this.state !== 'pending') return;
          this.state = 'failed';
          this.lastMessage =
            'AWS login did not produce a device code before timeout. ' +
            'Check AWS SSO profile configuration and retry.';
          logCommandOutcome('error', 'aws.login.exec.timeout', 'timedout', cmd, awsLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            candidateCommands: awsCandidates,
            commandLine: commandLine(cmd, awsLoginArgs),
            state: this.state,
            sawDeviceCode,
            awsProfile: profile,
          }, 'AWS login did not produce a device code within 30s');
          this.proc?.kill('SIGKILL');
          this.proc = null;
        }, 30_000);
        watchdog.unref();

        child.stdout?.on('data', handle);
        child.stderr?.on('data', handle);

        child.on('error', (err) => {
          const e = err as NodeJS.ErrnoException;
          if ((e.code === 'ENOENT' || e.code === 'EINVAL') && candidateIndex < awsCandidates.length - 1) {
            if (watchdog) clearTimeout(watchdog);
            candidateIndex += 1;
            trySpawn();
            return;
          }

          this.state = 'failed';
          this.lastMessage = `Failed to start aws: ${err.message}`;
          logCommandOutcome('error', 'aws.login.exec.error', 'failed', cmd, awsLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            candidateCommands: awsCandidates,
            commandLine: commandLine(cmd, awsLoginArgs),
            code: e.code,
            message: err.message,
          }, commandReason(err));
          if (watchdog) clearTimeout(watchdog);
        });

        child.on('close', (code) => {
          this.proc = null;
          if (this.state !== 'pending' && watchdog) clearTimeout(watchdog);

          if (code === 0) {
            this.state = 'succeeded';
            this.lastMessage = 'AWS login succeeded.';
            logCommandOutcome('info', 'aws.login.exec.finish', 'success', cmd, awsLoginArgs, {
              cmd,
              executablePath: resolvedExecutablePath,
              commandPath: cmd,
              resolvedExecutablePath,
              candidateCommands: awsCandidates,
              commandLine: commandLine(cmd, awsLoginArgs),
              code,
              state: this.state,
              sawDeviceCode,
              awsProfile: profile,
            }, 'AWS login completed successfully');
            return;
          }

          if (this.state === 'succeeded') return;

          if (code === -4058) {
            if (candidateIndex < awsCandidates.length - 1) {
              if (watchdog) clearTimeout(watchdog);
              candidateIndex += 1;
              trySpawn();
              return;
            }

            if (watchdog) clearTimeout(watchdog);
            this.state = 'failed';
            this.lastMessage =
              'AWS CLI executable not found for backend process (Windows ENOENT). ' +
              'Ensure aws is on PATH for the process running backend, then restart backend.';
            return;
          }

          if (!sawDeviceCode && this.state === 'pending') {
            this.lastMessage = 'Waiting for AWS device code...';
            return;
          }

          if (watchdog) clearTimeout(watchdog);
          this.state = 'failed';
          if (!this.lastMessage || this.lastMessage === 'Starting AWS login...') {
            this.lastMessage = `aws sso login exited with code ${code}`;
          }
        });
      };

        trySpawn();
        resolve({ message: this.lastMessage });
      })().catch((err) => {
        this.state = 'failed';
        this.lastMessage = err instanceof Error ? err.message : 'AWS login failed';
        resolve({ message: this.lastMessage });
      });
    });
  }
}

/** Build an SDK credential provider from the same per-session ini files the CLI uses. */
function sdkCredentials(env?: Record<string, string>) {
  const profile = env?.AWS_PROFILE || process.env.AWS_PROFILE || 'default';
  const credentialsFile = env?.AWS_SHARED_CREDENTIALS_FILE || process.env.AWS_SHARED_CREDENTIALS_FILE;
  const configFile = env?.AWS_CONFIG_FILE || process.env.AWS_CONFIG_FILE;

  // Prefer explicit static credentials from the session credentials file when present.
  // This keeps SDK auth deterministic even if the parent process has unrelated AWS env vars.
  const credentialProfiles = readAwsIniProfilesSync(credentialsFile);
  const explicit = credentialProfiles.get(profile);
  const accessKeyId = explicit?.aws_access_key_id?.trim();
  const secretAccessKey = explicit?.aws_secret_access_key?.trim();
  const sessionToken = explicit?.aws_session_token?.trim();

  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }

  return fromIni({
    profile,
    filepath: credentialsFile,
    configFilepath: configFile,
  });
}

async function resolveRegion(options: AwsExecOptions): Promise<string> {
  return (
    options.region ||
    options.env?.AWS_REGION ||
    options.env?.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    (await resolveProfileRegion(options.env)) ||
    'us-east-1'
  );
}

function describeAwsSdkError(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: string }).name;
    const message = (err as { message?: string }).message;
    if (name && message) return `${name}: ${message}`.slice(-300);
    if (message) return message.slice(-300);
  }
  return (err instanceof Error ? err.message : String(err)).slice(-300);
}

function parseAwsCliJson<T>(stdout: string): T {
  const text = stdout.trim();
  if (!text) {
    throw new Error('AWS CLI returned empty JSON output');
  }
  return JSON.parse(text) as T;
}

async function awsCliGetCallerIdentity(options: AwsExecOptions = {}): Promise<AwsIdentity | null> {
  const res = await run('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
    env: options.env,
    timeoutMs: 30_000,
  });
  if (res.code !== 0) {
    return null;
  }
  const parsed = parseAwsCliJson<{ Account?: string; Arn?: string; UserId?: string }>(res.stdout);
  if (!parsed.Account || !parsed.Arn || !parsed.UserId) return null;
  return {
    account: parsed.Account,
    arn: parsed.Arn,
    userId: parsed.UserId,
  };
}

async function awsCliListRegions(region: string, options: AwsExecOptions = {}): Promise<string[]> {
  const res = await run(
    'aws',
    ['ec2', 'describe-regions', '--all-regions', '--region', region, '--output', 'json'],
    { env: options.env, timeoutMs: 60_000 },
  );
  if (res.code !== 0) return [];

  const parsed = parseAwsCliJson<{ Regions?: Array<{ RegionName?: string }> }>(res.stdout);
  return (parsed.Regions ?? []).map((r) => r.RegionName).filter((name): name is string => !!name);
}

async function awsCliListEksNames(region: string, options: AwsExecOptions = {}): Promise<string[]> {
  const res = await run('aws', ['eks', 'list-clusters', '--region', region, '--output', 'json'], {
    env: options.env,
    timeoutMs: 60_000,
  });
  if (res.code !== 0) return [];
  const parsed = parseAwsCliJson<{ clusters?: string[] }>(res.stdout);
  return parsed.clusters ?? [];
}

async function awsCliDescribeEksCluster(name: string, region: string, options: AwsExecOptions = {}): Promise<EksCluster | null> {
  const res = await run(
    'aws',
    ['eks', 'describe-cluster', '--name', name, '--region', region, '--output', 'json'],
    { env: options.env, timeoutMs: 60_000 },
  );
  if (res.code !== 0) return null;

  const parsed = parseAwsCliJson<{
    cluster?: {
      name?: string;
      arn?: string;
      endpoint?: string;
      status?: string;
      version?: string;
    };
  }>(res.stdout);

  const cluster = parsed.cluster;
  if (!cluster?.name) return null;
  return {
    name: cluster.name,
    region,
    arn: cluster.arn,
    endpoint: cluster.endpoint,
    status: cluster.status,
    version: cluster.version,
  };
}

export async function awsStsGetCallerIdentity(options: AwsExecOptions = {}): Promise<AwsIdentity | null> {
  try {
    const region = await resolveRegion(options);
    const client = new STSClient({ region, credentials: sdkCredentials(options.env) });
    const result = await client.send(new GetCallerIdentityCommand({}));
    if (!result.Account || !result.Arn || !result.UserId) return null;
    return {
      account: result.Account,
      arn: result.Arn,
      userId: result.UserId,
    };
  } catch (err) {
    logWarn('aws.sdk.sts.get_caller_identity_failed', { error: describeAwsSdkError(err) });
    try {
      const cliIdentity = await awsCliGetCallerIdentity(options);
      if (cliIdentity) {
        logInfo('aws.cli.sts.get_caller_identity_fallback_succeeded', {
          account: cliIdentity.account,
        });
      }
      return cliIdentity;
    } catch (cliErr) {
      logWarn('aws.cli.sts.get_caller_identity_fallback_failed', {
        error: describeAwsSdkError(cliErr),
      });
      return null;
    }
  }
}

export async function awsSsoLogout(options: AwsExecOptions = {}): Promise<void> {
  const res = await run('aws', ['sso', 'logout'], options);
  if (res.code !== 0) {
    const msg = `${res.stderr || res.stdout}`.toLowerCase();
    if (!msg.includes('not logged in') && !msg.includes('no active sessions')) {
      throw new Error((res.stderr || res.stdout || 'AWS logout failed').trim());
    }
  }
}

/** Read the region configured for a profile directly from its AWS config file. */
async function resolveProfileRegion(env?: Record<string, string>): Promise<string | undefined> {
  const configPath = env?.AWS_CONFIG_FILE || process.env.AWS_CONFIG_FILE;
  const profile = env?.AWS_PROFILE || process.env.AWS_PROFILE || 'default';
  const configText = await readTextIfExists(configPath);
  return parseAwsConfigProfiles(configText).get(profile)?.region;
}

async function awsListRegions(options: AwsExecOptions = {}): Promise<{ regions: string[]; error?: string }> {
  const region = await resolveRegion(options);

  try {
    const client = new EC2Client({ region, credentials: sdkCredentials(options.env) });
    const result = await client.send(new DescribeRegionsCommand({ AllRegions: true }));
    const regions = (result.Regions ?? [])
      .map((r) => r.RegionName)
      .filter((name): name is string => !!name);
    if (regions.length > 0) return { regions };
    return {
      regions: [region],
      error: 'AWS returned no regions for this account. Showing clusters from the configured region only.',
    };
  } catch (err) {
    const reason = describeAwsSdkError(err);
    try {
      const cliRegions = await awsCliListRegions(region, options);
      if (cliRegions.length > 0) {
        return { regions: cliRegions };
      }
    } catch (cliErr) {
      logWarn('aws.cli.ec2.describe_regions_fallback_failed', { error: describeAwsSdkError(cliErr) });
    }
    return {
      regions: [region],
      error: `Could not list all AWS regions (${reason}). Showing clusters from region "${region}" only.`,
    };
  }
}

async function awsListEksNames(region: string, options: AwsExecOptions = {}): Promise<{ names: string[]; error?: string }> {
  try {
    const client = new EKSClient({ region, credentials: sdkCredentials(options.env) });
    const result = await client.send(new ListClustersCommand({}));
    return { names: result.clusters ?? [] };
  } catch (err) {
    const reason = describeAwsSdkError(err);
    try {
      const names = await awsCliListEksNames(region, options);
      if (names.length > 0) {
        return { names };
      }
    } catch (cliErr) {
      logWarn('aws.cli.eks.list_clusters_fallback_failed', { error: describeAwsSdkError(cliErr), region });
    }
    return { names: [], error: reason };
  }
}

async function awsDescribeEksCluster(
  name: string,
  region: string,
  options: AwsExecOptions = {},
): Promise<EksCluster | null> {
  try {
    const client = new EKSClient({ region, credentials: sdkCredentials(options.env) });
    const result = await client.send(new DescribeClusterCommand({ name }));
    const cluster = result.cluster;
    if (!cluster?.name) return null;

    return {
      name: cluster.name,
      region,
      arn: cluster.arn,
      endpoint: cluster.endpoint,
      status: cluster.status,
      version: cluster.version,
    };
  } catch {
    try {
      return await awsCliDescribeEksCluster(name, region, options);
    } catch {
      return null;
    }
  }
}

export async function awsListEks(
  options: AwsExecOptions = {},
): Promise<{ clusters: EksCluster[]; error?: string }> {
  const preferredRegion = await resolveRegion(options);

  const scanRegion = async (region: string) => {
    const { names, error } = await awsListEksNames(region, options);
    if (names.length === 0) return { region, clusters: [] as EksCluster[], error };

    const clusters = await Promise.all(
      names.map(async (name) => (await awsDescribeEksCluster(name, region, options)) ?? { name, region }),
    );
    return { region, clusters, error };
  };

  // Fast path: check the configured/default region first so users see clusters quickly
  // without waiting for a full multi-region scan.
  const preferredResult = await scanRegion(preferredRegion);
  if (preferredResult.clusters.length > 0) {
    preferredResult.clusters.sort((a, b) => a.name.localeCompare(b.name));
    return { clusters: preferredResult.clusters, error: preferredResult.error };
  }

  const { regions, error: regionsError } = await awsListRegions(options);
  if (regions.length === 0) {
    return { clusters: [], error: regionsError ?? preferredResult.error };
  }

  const remainingRegions = regions.filter((region) => region !== preferredRegion);
  const perRegion = await Promise.all(remainingRegions.map(scanRegion));
  perRegion.unshift(preferredResult);

  const allClusters = perRegion.flatMap((r) => r.clusters);
  const firstRegionFailure = perRegion.find((r) => r.error);

  allClusters.sort((a, b) => {
    const regionCmp = a.region.localeCompare(b.region);
    if (regionCmp !== 0) return regionCmp;
    return a.name.localeCompare(b.name);
  });

  const error =
    regionsError ??
    (allClusters.length === 0 && firstRegionFailure ? `${firstRegionFailure.region}: ${firstRegionFailure.error}` : undefined);
  return { clusters: allClusters, error };
}

/**
 * `aws eks update-kubeconfig` writes an exec-credential entry (`aws ... eks get-token ...`)
 * with no `env:` of its own, so when @kubernetes/client-node later spawns it to mint a
 * token, that subprocess only sees the backend's own process env, not this session's
 * isolated AWS_CONFIG_FILE/AWS_SHARED_CREDENTIALS_FILE — it falls back to the "default"
 * profile in the machine's real ~/.aws, which usually doesn't exist. Patch the entry we
 * just wrote so the exec plugin always resolves against this session's AWS files.
 */
async function pinAwsExecEnv(kubeconfigPath: string, clusterName: string, env?: Record<string, string>): Promise<void> {
  const awsConfigFile = env?.AWS_CONFIG_FILE || process.env.AWS_CONFIG_FILE;
  const awsCredentialsFile = env?.AWS_SHARED_CREDENTIALS_FILE || process.env.AWS_SHARED_CREDENTIALS_FILE;
  const awsProfile = env?.AWS_PROFILE || process.env.AWS_PROFILE;
  if (!awsConfigFile && !awsCredentialsFile) return;

  let doc: any;
  try {
    doc = yaml.load(await fsp.readFile(kubeconfigPath, 'utf8'));
  } catch (err) {
    logWarn('aws.eks.kubeconfig.pin_env_read_failed', { kubeconfigPath, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!doc || !Array.isArray(doc.users)) return;

  let changed = false;
  for (const userEntry of doc.users) {
    const exec = userEntry?.user?.exec;
    if (!exec || String(exec.command).toLowerCase() !== 'aws') continue;
    const args: string[] = Array.isArray(exec.args) ? exec.args.map(String) : [];
    const clusterIdx = args.indexOf('--cluster-name');
    if (clusterIdx === -1 || args[clusterIdx + 1] !== clusterName) continue;

    const execEnv: { name: string; value: string }[] = Array.isArray(exec.env) ? exec.env : [];
    const setVar = (name: string, value?: string) => {
      if (!value) return;
      const existing = execEnv.find((e) => e.name === name);
      if (existing) existing.value = value;
      else execEnv.push({ name, value });
    };
    setVar('AWS_CONFIG_FILE', awsConfigFile);
    setVar('AWS_SHARED_CREDENTIALS_FILE', awsCredentialsFile);
    setVar('AWS_PROFILE', awsProfile);
    setVar('AWS_SDK_LOAD_CONFIG', '1');
    exec.env = execEnv;
    changed = true;
  }

  if (!changed) return;
  await fsp.writeFile(kubeconfigPath, yaml.dump(doc), { encoding: 'utf8' });
}

export async function awsUpdateEksKubeconfig(opts: {
  region: string;
  name: string;
  alias?: string;
  kubeconfigPath?: string;
  env?: Record<string, string>;
}): Promise<void> {
  const args = ['eks', 'update-kubeconfig', '--name', opts.name, '--region', opts.region];
  args.push('--alias', opts.alias ?? opts.name);

  const kubeconfigPath = opts.kubeconfigPath ?? config.kubeconfigPath;
  if (kubeconfigPath) {
    args.push('--kubeconfig', kubeconfigPath);
  }

  await runOrThrow('aws', args, { env: opts.env });

  if (kubeconfigPath) {
    await pinAwsExecEnv(kubeconfigPath, opts.name, opts.env);
  }
}
