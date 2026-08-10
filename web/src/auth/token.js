const TOKEN_KEY = 'haeco-mes-ts.session-token';

export function getSessionToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(token) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function clearSessionToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}
