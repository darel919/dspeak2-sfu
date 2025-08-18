// Minimal in-memory Prometheus-style counters and gauges for lightweight metrics
const counters = {};
const gauges = {};

function incCounter(name, value = 1, labels = {}) {
  const key = metricKey(name, labels);
  if (!counters[key]) counters[key] = { name, value: 0, labels };
  counters[key].value += value;
}

function setGauge(name, value, labels = {}) {
  const key = metricKey(name, labels);
  gauges[key] = { name, value, labels };
}

function metricKey(name, labels) {
  const labelParts = Object.keys(labels).sort().map(k => `${k}="${labels[k]}"`).join(',');
  return `${name}{${labelParts}}`;
}

function renderPrometheus() {
  let out = '';
  for (const k of Object.keys(counters)) {
    const m = counters[k];
    out += `# TYPE ${m.name} counter\n`;
    const labelStr = formatLabels(m.labels);
    out += `${m.name}${labelStr} ${m.value}\n`;
  }
  for (const k of Object.keys(gauges)) {
    const m = gauges[k];
    out += `# TYPE ${m.name} gauge\n`;
    const labelStr = formatLabels(m.labels);
    out += `${m.name}${labelStr} ${m.value}\n`;
  }
  return out;
}

function formatLabels(labels) {
  const keys = Object.keys(labels || {});
  if (keys.length === 0) return '';
  const parts = keys.sort().map(k => `${k}="${labels[k]}"`);
  return `{${parts.join(',')}}`;
}

export { incCounter, setGauge, renderPrometheus };
