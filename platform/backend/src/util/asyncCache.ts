interface AsyncCacheState<T> {
  hasValue: boolean;
  value?: T;
  updatedAt: number;
  inFlight: Promise<T> | null;
  generation: number;
}

export interface AsyncCacheOptions<T> {
  staleAfterMs?: number;
  waitMs?: number;
  fallback: () => T | Promise<T>;
  onError?: (err: unknown) => void;
}

export class AsyncRefreshCache<T> {
  private state: AsyncCacheState<T> = {
    hasValue: false,
    updatedAt: 0,
    inFlight: null,
    generation: 0,
  };

  constructor(private readonly name: string) {}

  invalidate(): void {
    this.state = {
      hasValue: false,
      updatedAt: 0,
      inFlight: null,
      generation: this.state.generation + 1,
    };
  }

  async get(loader: () => Promise<T>, options: AsyncCacheOptions<T>): Promise<T> {
    const waitMs = options.waitMs ?? 100;
    const staleAfterMs = options.staleAfterMs ?? 10_000;

    if (this.state.hasValue) {
      if (Date.now() - this.state.updatedAt > staleAfterMs) {
        void this.refresh(loader, options);
      }
      return this.state.value as T;
    }

    const refreshPromise = this.refresh(loader, options);
    const completed = await Promise.race([
      refreshPromise.then(() => true),
      delay(waitMs).then(() => false),
    ]);

    if (completed && this.state.hasValue) {
      return this.state.value as T;
    }

    return await options.fallback();
  }

  private refresh(loader: () => Promise<T>, options: AsyncCacheOptions<T>): Promise<T> {
    if (this.state.inFlight) return this.state.inFlight;

    const generation = this.state.generation;

    this.state.inFlight = (async () => {
      try {
        const value = await loader();
        if (this.state.generation !== generation) {
          return value;
        }
        this.state.value = value;
        this.state.hasValue = true;
        this.state.updatedAt = Date.now();
        return value;
      } catch (err) {
        options.onError?.(err);
        return this.state.value as T;
      } finally {
        this.state.inFlight = null;
      }
    })();

    return this.state.inFlight;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
