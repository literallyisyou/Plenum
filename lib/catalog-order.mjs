// Keep routes grouped and compare version components as integers. The first
// number in a model name is its generation; dates and sizes are not versions.
function versionOf(model) {
  const label = String(model.label ?? model.name ?? '').split('(')[0];
  const id = String(model.id ?? model.ref ?? '').split('/').at(-1);
  for (const value of [label, id]) {
    const version = /(?<![\d.])\d{1,2}(?:\.\d{1,3}){0,3}(?![\d.A-Za-z])/i.exec(value);
    if (version) return version[0].split('.').map(Number);
  }
  return null;
}

export function orderModelCatalog(models) {
  const groups = new Map();
  for (const model of models) {
    const group = groups.get(model.provider) ?? [];
    if (!groups.has(model.provider)) groups.set(model.provider, group);
    const isDefault = model.id === 'default' || model.ref?.endsWith(':default');
    group.push({ model, version: versionOf(model), isDefault: Boolean(isDefault) });
  }
  return [...groups.values()].flatMap(group => group.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (!a.version || !b.version) return Number(Boolean(b.version)) - Number(Boolean(a.version));
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  }).map(({ model }) => model));
}
