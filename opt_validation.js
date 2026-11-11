export function parseKpiOutput(output) {
  const last = String(output).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let value;
  try {
    const parsed = JSON.parse(last);
    value = typeof parsed === 'number' ? parsed : parsed?.kpi;
  } catch {
    value = Number(last);
  }
  if (!last || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid KPI output: ${JSON.stringify(last)}`);
  }
  return value;
}