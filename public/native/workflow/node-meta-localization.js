// ABOUTME: Resolves locale-specific display text without changing stored NodeMeta.

import { getLocale, t } from "../../i18n.js";

function localizedField(value, translate) {
  return value?.labelKey ? { ...value, label: translate(value.labelKey) } : value;
}

function ownValue(record, key) {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function localizeNodeMeta(meta, translate = t) {
  if (!meta) return meta;
  const locale = getLocale();
  const localized = ownValue(meta.i18n, locale);
  const localizePort = (port, group) => {
    const label = ownValue(localized?.[group], port.name);
    return { ...localizedField(port, translate), ...(label ? { label } : {}) };
  };
  return {
    ...meta,
    ...(meta.labelKey ? { label: translate(meta.labelKey) } : {}),
    ...(meta.descriptionKey ? { description: translate(meta.descriptionKey) } : {}),
    ...(localized?.label ? { label: localized.label } : {}),
    ...(localized?.description !== undefined ? { description: localized.description } : {}),
    inputs: (meta.inputs ?? []).map((port) => localizePort(port, "inputs")),
    outputs: (meta.outputs ?? []).map((port) => localizePort(port, "outputs")),
    params: (meta.params ?? []).map((param) => {
      const translated = ownValue(localized?.params, param.name);
      return {
        ...localizedField(param, translate),
        ...(translated?.label ? { label: translated.label } : {}),
        ...(param.descriptionKey ? { description: translate(param.descriptionKey) } : {}),
        ...(translated?.description !== undefined ? { description: translated.description } : {}),
        ...(param.options
          ? {
              options: param.options.map((option) => ({
                ...localizedField(option, translate),
                ...(ownValue(translated?.options, option.value)
                  ? { label: ownValue(translated?.options, option.value) }
                  : {}),
              })),
            }
          : {}),
      };
    }),
  };
}

export function localizeNodeMetaMap(nodeMetas, translate = t) {
  return new Map([...nodeMetas].map(([key, meta]) => [key, localizeNodeMeta(meta, translate)]));
}
