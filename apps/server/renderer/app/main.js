/**
 * Renderer entry point. Composes the store, transport, canvas renderer, and
 * UI panels. Live WebSocket mode only — the host streams full frames over
 * `/ws` and accepts protocol commands on the same socket.
 */
import { RendererStore } from './state/RendererStore.js';
import { RendererApp } from './RendererApp.js';
import { WebSocketRendererTransport } from './transports/WebSocketRendererTransport.js';
import { StatusPanel } from './ui/StatusPanel.js';
import { LegendPanel } from './ui/Legend.js';
import { MetricsPanel } from './ui/MetricsPanel.js';
import { EventLog } from './ui/EventLog.js';
import { Controls } from './ui/Controls.js';
import { FarmPanel } from './ui/FarmPanel.js';
import { FieldWindow } from './ui/FieldWindow.js';
import { makeSectionsCollapsible } from './ui/collapsible.js';
import { makeColumnsResizable } from './ui/columnResize.js';

const store = new RendererStore();
const transport = new WebSocketRendererTransport({
  url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`,
});

const canvas = document.getElementById('farm-canvas');
const appRef = { current: null };
const ui = {
  statusPanel: new StatusPanel(document.getElementById('status-bar')),
  // The legend is generated from the appearance registry and never changes
  // after construction, so it is built once and not given to the app to render.
  legendPanel: new LegendPanel(document.getElementById('legend-panel')),
  metricsPanel: new MetricsPanel(document.getElementById('metrics-panel')),
  eventLog: new EventLog(document.getElementById('event-log-panel')),
  controls: null,
  farmPanel: null,
  fieldWindow: null,
};
// The floating field window lives over the viewport: click a field on the
// map and it opens beside the click with that field's info and actions.
ui.fieldWindow = new FieldWindow(document.getElementById('field-window'), {
  onCommand: (command) => appRef.current.sendCommand(command),
  onStatus: (text, kind) => ui.statusPanel.setCommandStatus(text, kind),
  onClose: () => appRef.current.clearSelection(),
});
ui.farmPanel = new FarmPanel(document.getElementById('farm-panel'), {
  onCommand: (command) => appRef.current.sendCommand(command),
  onStatus: (text, kind) => ui.statusPanel.setCommandStatus(text, kind),
});
ui.controls = new Controls(document.getElementById('controls-panel'), {
  onCommand: (command) => appRef.current.sendCommand(command),
  // Stepping pauses first, so the button never fails on a running simulation.
  onStep: (ticks) => appRef.current.stepTicks(ticks),
  onToggleRun: () => appRef.current.toggleRun(),
  onRestart: (command) => appRef.current.restart(command),
  onRecenter: () => appRef.current.recenter(),
  onReconnect: () => appRef.current.reconnect(),
  // The command result is drawn in the status bar, beside the run state it
  // explains — this panel reports, the status bar shows.
  onStatus: (text, kind) => ui.statusPanel.setCommandStatus(text, kind),
});

// Each h2-headed panel folds up when its header is clicked (the Legend is
// already a <details>, so it is not listed here).
makeSectionsCollapsible([
  document.getElementById('controls-panel'),
  document.getElementById('farm-panel'),
  document.getElementById('metrics-panel'),
  document.getElementById('event-log-panel'),
]);

// Each aside can be widened by dragging its inner edge. The default width is
// also the minimum; a double-click on the handle puts it back.
makeColumnsResizable();

const app = new RendererApp({ store, transport, canvas, ui });
appRef.current = app;
app.start();
