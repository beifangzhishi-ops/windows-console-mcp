export class ConnectionScopedToolListCache {
  constructor() {
    this.connectionId = null;
    this.tools = null;
  }

  get(connectionId) {
    if (!connectionId || connectionId !== this.connectionId) return null;
    return this.tools;
  }

  set(connectionId, tools) {
    if (!connectionId) throw new Error('Tool-list cache requires a connection id.');
    if (!Array.isArray(tools)) throw new Error('Tool-list cache requires a tools array.');
    this.connectionId = connectionId;
    this.tools = tools;
    return tools;
  }
}
