import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APPROVAL_UI_HTML } from '../router/approval-app.mjs';

const script = APPROVAL_UI_HTML.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
assert.ok(script);

const id = '00000000-0000-4000-8000-000000000011';
const op = '00000000-0000-4000-8000-000000000012';
const initial = {
  kind: 'approval', approval_id: id, operation_id: op,
  device_id: '6v', tool_name: 'get_config',
  state: 'pending', action_summary: 'get_config on 6v',
  requested_duration_seconds: 60,
};

async function settle() {
  for (let n = 0; n < 12; n++) await new Promise((resolve) => setImmediate(resolve));
}

function mount({ state = 'pending', widgetState = null, statusFailure = false, resolutionFailure = false, mismatch = false } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const calls = [];
  const element = (name) => {
    if (!nodes.has(name)) {
      nodes.set(name, {
        textContent: '', dataset: {}, disabled: true,
        addEventListener(type, fn) { this[type] = fn; },
      });
    }
    return nodes.get(name);
  };
  let currentState = state;
  const terminal = (value) => ({
    ...initial, state: value, approval_required: value === 'pending',
    action_failed: false, grant_active: value === 'consumed',
  });
  const send = (message) => {
    calls.push(message);
    if (!message.id) return;
    queueMicrotask(() => {
      const response = { jsonrpc: '2.0', id: message.id, result: {} };
      if (message.method === 'ui/initialize') {
        response.result = { hostCapabilities: { message: { text: true } } };
      } else if (message.method === 'tools/call') {
        const tool = message.params.name;
        if (tool === 'get_approval_status') {
          response.result = statusFailure ? { isError: true } : {
            structuredContent: {
              ...terminal(currentState),
              ...(mismatch ? { operation_id: 'different-operation' } : {}),
              result_unavailable: currentState !== 'pending',
              grant_active: false,
            },
          };
        }
        if (tool === 'resolve_pending_action') {
          currentState = 'consumed';
          response.result = resolutionFailure
            ? { isError: true }
            : { structuredContent: terminal('consumed') };
        }
      }
      listeners.get('message')?.({
        source: parent, data: response,
      });
    });
  };
  const parent = { postMessage: send };
  const openai = {
    toolResponseMetadata: {
      mcp_tool_result: {
        structuredContent: initial,
        _meta: { approval_nonce: 'valid-private-nonce-from-original-card' },
      },
    },
    widgetState,
    setWidgetState(value) { this.widgetState = value; },
    notifyIntrinsicHeight() {},
  };
  const window = {
    parent, openai,
    addEventListener(name, cb) { listeners.set(name, cb); },
  };
  vm.runInNewContext(script, {
    window, document: { getElementById: element },
    setTimeout, clearTimeout, Promise, Date, console,
  }, { timeout: 1500 });
  return {
    calls, openai, nodes,
    approve: () => element('approve').click(),
    get approvedDisabled() { return element('approve').disabled; },
    get deniedDisabled() { return element('deny').disabled; },
    get status() { return element('status').textContent; },
    globalsEarly: () => listeners.get('openai:set_globals')?.(),
  };
}

const live = mount();
live.globalsEarly();
await settle();
assert.equal(live.approvedDisabled, false);
assert.equal(live.deniedDisabled, false);
assert.ok(live.calls.some((call) => call.params?.name === 'get_approval_status'));
live.approve();
await settle();
assert.equal(live.approvedDisabled, true);
assert.match(live.status, /Approved/u);
assert.equal(live.openai.widgetState.state, 'consumed');
assert.ok(live.calls.some((call) => call.method === 'ui/message'));
assert.ok(!JSON.stringify(live.openai.widgetState).includes('nonce'));

const remounted = mount({ state: 'consumed', widgetState: live.openai.widgetState });
remounted.globalsEarly();
await settle();
assert.equal(remounted.approvedDisabled, true);
assert.equal(remounted.deniedDisabled, true);
assert.match(remounted.status, /Archived decision/u);
assert.ok(!remounted.calls.some((call) => call.params?.name === 'resolve_pending_action'));

for (const options of [{ statusFailure: true }, { mismatch: true }]) {
  const unverified = mount(options);
  unverified.globalsEarly();
  await settle();
  assert.equal(unverified.approvedDisabled, true);
  assert.match(unverified.status, /cannot be verified/u);
}

const lostResponse = mount({ resolutionFailure: true });
lostResponse.globalsEarly();
await settle();
lostResponse.approve();
await settle();
assert.equal(lostResponse.approvedDisabled, true);
assert.match(lostResponse.status, /Approved/u);
assert.equal(lostResponse.calls.filter((call) => call.params?.name === 'resolve_pending_action').length, 1);

console.log('WCM MCP App remount, early globals, fail-closed card tests: PASS');
