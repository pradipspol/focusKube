import crypto from 'node:crypto';
import { Collection } from '../db/localStore.js';
import { kube } from '../kube/client.js';
import type { ChangeEventStore } from './store.js';
import type { RecordingSessionDoc } from './types.js';
import { Recording } from './recorder.js';
import { logInfo, logWarn, logError } from '../util/logger.js';
import { broadcastRecordingStatus } from '../ws/observability.js';

/** Compute unique recording key for (userId, context, serverUrl) combination */
function computeRecordingKey(userId: string, context: string, serverUrl?: string): string {
  return `${userId}:${context}:${serverUrl || 'default'}`;
}

let recordingsCollection: Collection<RecordingSessionDoc> | null = null;

function recordings(): Collection<RecordingSessionDoc> {
  if (!recordingsCollection) {
    recordingsCollection = new Collection<RecordingSessionDoc>('observability-recordings.json', {
      reviveDates: ['startedAt', 'stoppedAt'],
    });
  }
  return recordingsCollection;
}

export class RecordingLifecycle {
  /** Map of recording key -> Recording instance (compound key: userId:context:serverUrl) */
  private activeRecordings: Map<string, Recording> = new Map();
  private reconcileInterval: NodeJS.Timeout | null = null;

  constructor(private store: ChangeEventStore) {}

  /** Extract server URL from kubeConfig context */
  private async getServerUrl(context: string, kubeconfigPath?: string, fallbackContext?: string, azureConfigDir?: string): Promise<string | undefined> {
    try {
      const kubeConfig = await kube.rawConfig(context, { kubeconfigPath, fallbackContext, azureConfigDir });
      const cluster = kubeConfig.getCurrentCluster();
      return cluster?.server;
    } catch (err) {
      logWarn('observability.recording.server_url_lookup_failed', {
        context,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async startRecording(
    context: string,
    userId: string,
    kubeconfigPath?: string,
    fallbackContext?: string,
    azureConfigDir?: string,
    retentionMs = 72 * 60 * 60 * 1000,
  ): Promise<{ recordingId: string; status: string }> {
    let recordingId: string | undefined;
    try {
      logInfo('observability.recording.lifecycle_start', { context, userId });

      // Get server URL to ensure unique recording per cluster
      logInfo('observability.recording.server_url_lookup_start', { context, userId });
      const serverUrl = await this.getServerUrl(context, kubeconfigPath, fallbackContext, azureConfigDir);
      logInfo('observability.recording.server_url_lookup_complete', { context, userId, serverUrl: serverUrl ?? null });
      const recordingKey = computeRecordingKey(userId, context, serverUrl);

      // Check if already recording for this user+context+server combo
      const existing = recordings().findOne(
        (doc) => doc.recordingKey === recordingKey && (doc.status === 'active' || (doc.status as string) === 'starting'),
      );

      if (existing) {
        const liveRecording = this.activeRecordings.get(recordingKey);
        if (liveRecording) {
          logInfo('observability.recording.already_active', {
            recordingId: existing.id,
            userId,
            context,
            serverUrl,
          });
          return {
            recordingId: existing.id,
            status: 'active',
          };
        }

        recordings().updateOne(
          (doc) => doc.id === existing.id,
          { status: 'error', errorMessage: 'Persisted recording had no live informer process' },
        );
        logWarn('observability.recording.stale_persisted_record', {
          recordingId: existing.id,
          userId,
          context,
          serverUrl,
        });
      }

      recordingId = crypto.randomUUID();
      const now = new Date();

      // Create recording doc with full context for multi-user, multi-cluster support
      recordings().insertOne({
        id: recordingId,
        recordingKey,
        context,
        userId,
        serverUrl,
        kubeconfigPath,
        startedAt: now,
        status: 'active',
      });

      // Create and start informers
  const recording = new Recording(recordingId, context, userId, this.store, kubeconfigPath, fallbackContext, azureConfigDir, retentionMs, serverUrl);
      logInfo('observability.recording.informers_start', { recordingId, context, userId });
      await recording.start();
      logInfo('observability.recording.informers_start_complete', { recordingId, context, userId });

      this.activeRecordings.set(recordingKey, recording);

      logInfo('observability.recording.started', {
        recordingId,
        userId,
        context,
        serverUrl,
      });

      // Broadcast status update to WebSocket subscribers
      broadcastRecordingStatus(context, {
        recordingId,
        status: 'active',
        userId,
        context,
        startedAt: now,
      });

      return {
        recordingId,
        status: 'active',
      };
    } catch (err) {
      if (recordingId) {
        recordings().updateOne(
          (doc) => doc.id === recordingId,
          { status: 'error', errorMessage: err instanceof Error ? err.message : String(err) },
        );
      }
      logError('observability.recording.start_failed', {
        recordingId: recordingId ?? null,
        context,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async stopRecording(context: string, userId: string, serverUrl?: string): Promise<void> {
    const recordingKey = computeRecordingKey(userId, context, serverUrl);
    const recording = this.activeRecordings.get(recordingKey);

    if (recording) {
      await recording.stop();
      this.activeRecordings.delete(recordingKey);
    }

    const now = new Date();
    recordings().updateOne(
      (doc) => doc.recordingKey === recordingKey && doc.status === 'active',
      { status: 'stopped', stoppedAt: now },
    );

    logInfo('observability.recording.stopped', { userId, context, serverUrl });

    // Broadcast status update to WebSocket subscribers
    broadcastRecordingStatus(context, {
      status: 'stopped',
      userId,
      context,
      stoppedAt: now,
    });
  }

  /** Resume active recordings from disk on server startup (Tier 2 foundation) */
  async resumeRecordingsOnBoot(retentionMs = 72 * 60 * 60 * 1000): Promise<void> {
    try {
      const activeDocs = recordings().find((doc) => doc.status === 'active');

      if (activeDocs.length === 0) {
        logInfo('observability.lifecycle.boot_reconciliation', { resumedCount: 0 });
        return;
      }

      logInfo('observability.lifecycle.boot_reconciliation_start', { activeCount: activeDocs.length });

      let resumedCount = 0;
      for (const doc of activeDocs) {
        try {
          const recordingKey = computeRecordingKey(doc.userId, doc.context, doc.serverUrl);
          const recording = new Recording(
            doc.id,
            doc.context,
            doc.userId,
            this.store,
            doc.kubeconfigPath,
            undefined,
            undefined,
            retentionMs,
            doc.serverUrl,
          );

          await recording.start();
          this.activeRecordings.set(recordingKey, recording);
          resumedCount++;

          logInfo('observability.recording.resumed', {
            recordingId: doc.id,
            userId: doc.userId,
            context: doc.context,
          });

          // Broadcast status update
          broadcastRecordingStatus(doc.context, {
            recordingId: doc.id,
            status: 'active',
            userId: doc.userId,
            context: doc.context,
            startedAt: doc.startedAt,
          });
        } catch (err) {
          logError('observability.recording.resume_failed', {
            recordingId: doc.id,
            userId: doc.userId,
            context: doc.context,
            error: err instanceof Error ? err.message : String(err),
          });

          // Mark as errored on disk
          recordings().updateOne(
            (d) => d.id === doc.id,
            { status: 'error', errorMessage: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      logInfo('observability.lifecycle.boot_reconciliation_complete', { resumedCount });
    } catch (err) {
      logWarn('observability.lifecycle.boot_reconciliation_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stopAllRecordings(): Promise<void> {
    const keys = Array.from(this.activeRecordings.keys());
    for (const key of keys) {
      try {
        const recording = this.activeRecordings.get(key);
        if (recording) {
          await recording.stop();
          this.activeRecordings.delete(key);
        }
      } catch (err) {
        logError('observability.recording.stop_failed', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
  }

  async getStatus(context?: string, userId?: string): Promise<RecordingSessionDoc | RecordingSessionDoc[] | null> {
    const matches = (doc: RecordingSessionDoc) =>
      (doc.status === 'active' || doc.status === 'stopped' || doc.status === 'error') &&
      (!context || doc.context === context) &&
      (!userId || doc.userId === userId);

    if (context && userId) {
      return recordings().findOne(matches) ?? null;
    }

    return recordings().find(matches);
  }
}
