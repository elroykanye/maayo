export interface WorkingSetDescriptor {
  id: string;
  tenantId: string;
  channel: string;
  projectionKey: string;
  projectionRevision: string;
  schemaVersion: string;
  filter?: Readonly<Record<string, string | number | boolean | null>>;
}

export type WorkingSetMode = 'active' | 'prefetch' | 'paused';

export interface WorkingSetEntry {
  descriptor: WorkingSetDescriptor;
  mode: WorkingSetMode;
}

export interface WorkingSetRegistryOptions {
  evict?: (descriptor: WorkingSetDescriptor) => void | Promise<void>;
  onChange?: (entries: readonly WorkingSetEntry[]) => void;
}

export class WorkingSetRegistry {
  private readonly entries = new Map<string, WorkingSetEntry>();

  constructor(private readonly options: WorkingSetRegistryOptions = {}) {}

  subscribe(descriptor: WorkingSetDescriptor): void {
    this.upsert(descriptor, 'active');
  }

  prefetch(descriptor: WorkingSetDescriptor): void {
    this.upsert(descriptor, 'prefetch');
  }

  activate(id: string): void {
    this.setMode(id, 'active');
  }

  pause(id: string): void {
    this.setMode(id, 'paused');
  }

  unsubscribe(id: string): void {
    if (this.entries.delete(id)) this.changed();
  }

  async evict(id: string): Promise<void> {
    const entry = this.require(id);
    await this.options.evict?.(entry.descriptor);
    this.entries.delete(id);
    this.changed();
  }

  active(): WorkingSetDescriptor[] {
    return this.byMode('active');
  }

  prefetchable(): WorkingSetDescriptor[] {
    return this.byMode('prefetch');
  }

  all(): WorkingSetEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  private upsert(descriptor: WorkingSetDescriptor, mode: WorkingSetMode): void {
    validateDescriptor(descriptor);
    const existing = this.entries.get(descriptor.id);
    if (existing && identity(existing.descriptor) !== identity(descriptor)) {
      throw new Error(`Working set ${descriptor.id} identity cannot change; evict it first`);
    }
    this.entries.set(descriptor.id, { descriptor: { ...descriptor }, mode });
    this.changed();
  }

  private setMode(id: string, mode: WorkingSetMode): void {
    const entry = this.require(id);
    this.entries.set(id, { ...entry, mode });
    this.changed();
  }

  private require(id: string): WorkingSetEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown working set: ${id}`);
    return entry;
  }

  private byMode(mode: WorkingSetMode): WorkingSetDescriptor[] {
    return [...this.entries.values()]
      .filter((entry) => entry.mode === mode)
      .map((entry) => ({ ...entry.descriptor }));
  }

  private changed(): void {
    this.options.onChange?.(this.all());
  }
}

function validateDescriptor(value: WorkingSetDescriptor): void {
  for (const [name, item] of Object.entries(value)) {
    if (name === 'filter') continue;
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`Working set ${name} must be a non-empty string`);
    }
  }
}

function identity(value: WorkingSetDescriptor): string {
  return JSON.stringify([
    value.tenantId,
    value.channel,
    value.projectionKey,
    value.projectionRevision,
    value.schemaVersion,
    value.filter ?? null,
  ]);
}
