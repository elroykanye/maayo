import { describe, expect, it, vi } from 'vitest';
import { WorkingSetRegistry, type WorkingSetDescriptor } from '../index';

const descriptor = (id: string, channel = 'org:1'): WorkingSetDescriptor => ({
  id,
  tenantId: 'tenant-a',
  channel,
  projectionKey: 'teacher:42',
  projectionRevision: 'grants:7',
  schemaVersion: '3',
});

describe('working-set registry', () => {
  it('supports subscribe, prefetch, activate, pause, unsubscribe, and evict', async () => {
    const evict = vi.fn(async () => undefined);
    const registry = new WorkingSetRegistry({ evict });

    registry.subscribe(descriptor('visible'));
    registry.prefetch(descriptor('next', 'org:2'));
    expect(registry.active().map((set) => set.id)).toEqual(['visible']);
    expect(registry.prefetchable().map((set) => set.id)).toEqual(['next']);

    registry.activate('next');
    registry.pause('visible');
    expect(registry.active().map((set) => set.id)).toEqual(['next']);
    registry.unsubscribe('next');
    await registry.evict('visible');
    expect(evict).toHaveBeenCalledWith(descriptor('visible'));
    expect(registry.all()).toEqual([]);
  });

  it('rejects descriptor identity changes under an existing id', () => {
    const registry = new WorkingSetRegistry();
    registry.subscribe(descriptor('visible'));
    expect(() => registry.subscribe({ ...descriptor('visible'), tenantId: 'tenant-b' }))
      .toThrow(/identity/i);
  });
});
