export function segment(value) {
  return encodeURIComponent(String(value));
}

export function uploadForm(file, fields = {}) {
  const form = new FormData();
  form.append('file', file);
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.append(key, value);
  });
  return form;
}
