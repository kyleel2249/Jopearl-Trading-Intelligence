// The plain-text device profile must never gain new secrets; those belong in the encrypted vault.
export const SECRET_PATTERN = /(KEY|SECRET|PASSWORD|PASSPHRASE|TOKEN|DATABASE_URL|PRIVATE|CREDENTIAL|AUTH)/i;

// Returns the variables that may be written unencrypted. Secret values saved by earlier releases
// are carried over unchanged until the vault holds them, so an upgrade never destroys settings.
export function plainProfileVariables(variables = {}, previouslyStored = {}, vaultSaved = false) {
  const result = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!SECRET_PATTERN.test(key)) result[key] = value;
    else if (!vaultSaved && Object.hasOwn(previouslyStored, key)) result[key] = previouslyStored[key];
  }
  return result;
}

export const unsavedSecretCount = (variables = {}, stored = {}) =>
  Object.keys(variables).filter(key => SECRET_PATTERN.test(key) && variables[key] && stored[key] !== variables[key]).length;
