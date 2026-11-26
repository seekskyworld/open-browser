// Requests in a page lane enter this scheduler only when the preceding operation settles.
export class WorkspaceScheduler {
  constructor(maximum, { lowMemoryMiB = 0, availableBytes = () => process.availableMemory() } = {}) {
    if (!Number.isSafeInteger(lowMemoryMiB) || lowMemoryMiB < 0) throw new Error('invalid_memory_watermark');
    this.maximum = maximum;
    this.limit = maximum;
    this.active = 0;
    this.queues = new Map();
    this.lowBytes = lowMemoryMiB * 1024 * 1024;
    this.availableBytes = availableBytes;
    this.sampledAt = -Infinity;
    this.completed = 0;
    this.waitMs = 0;
    this.executionMs = 0;
  }

  refreshLimit(now) {
    if (!this.lowBytes || now - this.sampledAt < 1000) return;
    this.sampledAt = now;
    const available = this.availableBytes();
    // Unknown readings keep the previous limit. Separate watermarks avoid rapid oscillation.
    if (available > 0 && available < this.lowBytes) this.limit = Math.max(1, Math.floor(this.maximum / 2));
    if (available > this.lowBytes * 1.5) this.limit = this.maximum;
  }

  drain() {
    this.refreshLimit(performance.now());
    while (this.active < this.limit && this.queues.size) {
      const [workspace, queue] = this.queues.entries().next().value;
      this.queues.delete(workspace);
      const item = queue.shift();
      if (queue.length) this.queues.set(workspace, queue);
      this.active++;
      item.start();
    }
  }

  async run(workspace, work, signal, enqueuedAt) {
    if (signal.aborted) throw Object.assign(new Error('operation_cancelled'), {code:'operation_cancelled'});
    await new Promise((resolve, reject) => {
      const queue = this.queues.get(workspace) || [];
      const item = { start: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length && this.queues.get(workspace) === queue) this.queues.delete(workspace);
        reject(Object.assign(new Error('operation_cancelled'), {code:'operation_cancelled'}));
      };
      signal.addEventListener('abort', abort, {once:true});
      queue.push(item);
      this.queues.set(workspace, queue);
      this.drain();
    });
    const started = performance.now();
    this.waitMs += started - enqueuedAt;
    try { return await work(); }
    finally {
      this.executionMs += performance.now() - started;
      this.completed++;
      this.active--;
      this.drain();
    }
  }

  snapshot(pending) {
    return { maximum:this.maximum, limit:this.limit, active:this.active, pending,
      lowMemoryMiB:this.lowBytes / 1048576, completed:this.completed,
      cumulativeWaitMs:Math.round(this.waitMs), cumulativeExecutionMs:Math.round(this.executionMs) };
  }
}
