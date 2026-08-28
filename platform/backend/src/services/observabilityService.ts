import { correlateEvents } from '../observability/correlate.js';
import { RecordingLifecycle } from '../observability/lifecycle.js';
import { getChangeEventStore } from '../observability/store.js';

let lifecycle: RecordingLifecycle | null = null;

function getLifecycle(): RecordingLifecycle {
  if (!lifecycle) {
    lifecycle = new RecordingLifecycle(getChangeEventStore());
  }
  return lifecycle;
}

export class ObservabilityService {
  constructor(
    private readonly deps: {
      lifecycleFactory?: () => RecordingLifecycle;
      correlate?: typeof correlateEvents;
    } = {},
  ) {}

  private lifecycle(): RecordingLifecycle {
    return this.deps.lifecycleFactory ? this.deps.lifecycleFactory() : getLifecycle();
  }

  private correlateFn(): typeof correlateEvents {
    return this.deps.correlate ?? correlateEvents;
  }

  isAvailable(): boolean {
    return true;
  }

  getLifecycleInstance(): RecordingLifecycle {
    return this.lifecycle();
  }

  async getStatus(context: string | undefined, userId: string | undefined) {
    return this.lifecycle().getStatus(context, userId);
  }

  async startRecording(
    context: string,
    userId: string,
    kubeconfigPath?: string,
    fallbackContext?: string,
    azureConfigDir?: string,
  ) {
    return this.lifecycle().startRecording(context, userId, kubeconfigPath, fallbackContext, azureConfigDir);
  }

  async stopRecording(context: string, userId: string, serverUrl?: string) {
    return this.lifecycle().stopRecording(context, userId, serverUrl);
  }

  async queryEvents(
    context: string,
    from: Date,
    to: Date,
    filters?: { namespace?: string; category?: string; severity?: string },
  ) {
    const store = getChangeEventStore();
    return store.queryEvents(context, from, to, filters);
  }

  async queryStateAt(context: string, timestamp: Date, namespace?: string) {
    const store = getChangeEventStore();
    return store.queryStateAt(context, timestamp, namespace);
  }

  async correlate(context: string, from: Date, to: Date) {
    const store = getChangeEventStore();
    const events = await store.queryEvents(context, from, to);
    return this.correlateFn()(events);
  }
}

export const observabilityService = new ObservabilityService();