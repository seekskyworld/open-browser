import { workspaceView } from './workspace-state.mjs';

// Coalesces synchronous phase changes into one ordered activity update. The
// service keeps all browser state ownership while this adapter owns delivery.
export class ActivityNotifier {
  constructor(onActivity, hasWorkspace) {
    this.onActivity = onActivity;
    this.hasWorkspace = hasWorkspace;
    this.pending = new Map();
  }

  notify(ws) {
    if (!this.onActivity || !this.hasWorkspace(ws.id)) return;
    const pending = this.pending.get(ws.id) || { snapshot: null, scheduled: false };
    pending.snapshot = workspaceView(ws);
    this.pending.set(ws.id, pending);
    if (pending.scheduled) return;
    pending.scheduled = true;
    void Promise.resolve().then(async () => {
      const current = this.pending.get(ws.id);
      if (!current) return;
      const snapshot = current.snapshot;
      current.scheduled = false;
      if (this.hasWorkspace(ws.id)) await this.onActivity(snapshot);
      if (current.snapshot === snapshot) this.pending.delete(ws.id);
      else if (!current.scheduled) this.notify(ws);
    }).catch(() => {
      const current = this.pending.get(ws.id);
      if (current?.snapshot === pending.snapshot) this.pending.delete(ws.id);
    });
  }

  clear(workspaceId) { this.pending.delete(workspaceId); }
}
