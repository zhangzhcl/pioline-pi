// ABOUTME: Creates a current-locale display copy of a NodeMeta approval candidate.

function ownValue(record, key) {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function localizedText(record, key, fallback) {
  const value = ownValue(record, key);
  return typeof value === "string" ? value : fallback;
}

export function nodeMetaApprovalPreview(meta, locale) {
  const { i18n, ...definition } = meta;
  const translation = ownValue(i18n, locale);

  return {
    ...definition,
    label: localizedText(translation, "label", meta.label),
    description: localizedText(translation, "description", meta.description),
    inputs: (meta.inputs ?? []).map((port) => ({
      ...port,
      label: localizedText(translation?.inputs, port.name, port.label),
    })),
    outputs: (meta.outputs ?? []).map((port) => ({
      ...port,
      label: localizedText(translation?.outputs, port.name, port.label),
    })),
    params: (meta.params ?? []).map((param) => {
      const localizedParam = ownValue(translation?.params, param.name);
      return {
        ...param,
        label: localizedText(localizedParam, "label", param.label),
        ...(Object.hasOwn(localizedParam ?? {}, "description")
          ? { description: localizedParam.description }
          : {}),
        ...(Array.isArray(param.options)
          ? {
              options: param.options.map((option) => ({
                ...option,
                label: localizedText(localizedParam?.options, option.value, option.label),
              })),
            }
          : {}),
      };
    }),
  };
}
