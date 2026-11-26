export const K_SEPARATOR = ", ";

function tmpTrim(label: string): string {
  return label.trim();
}

export function joinLabels(labels: string[]): string {
  return labels.map(tmpTrim).join(K_SEPARATOR);
}
