/** @param {string} value */
export function isMotrixOperatorToken(value) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}
