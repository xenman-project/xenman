// What a new password has to be, for the server (validatePassword in auth.ts)
// and the pages that show the rules while typing. No Node.js here: the browser
// loads it too.

export const PASSWORD_MIN_LENGTH = 12;

/** The rules shown while typing; passwordProblem() checks these and more. */
export const PASSWORD_RULES: { text: string; ok: (p: string) => boolean }[] = [
  { text: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { text: "A lowercase letter", ok: (p) => /[a-z]/.test(p) },
  { text: "An uppercase letter", ok: (p) => /[A-Z]/.test(p) },
  { text: "A number", ok: (p) => /[0-9]/.test(p) },
];

// Words that make up the passwords guessed first, once digits and symbols
// are taken off ("Password1234!", "Welcome2026!!", "Qwertz123456").
const COMMON = new Set([
  "password", "passwort", "passwd", "pass", "kennwort", "geheim", "secret", "letmein", "changeme",
  "welcome", "willkommen", "hello", "hallo", "admin", "administrator", "root", "login", "user", "guest", "test", "demo",
  "qwerty", "qwertz", "qwertyuiop", "qwertzuiop", "asdfgh", "asdfghjkl", "yxcvbnm", "zxcvbnm", "abc", "abcdef", "abcdefgh",
  "xenman", "xenserver", "xencenter", "citrix", "vmware", "server", "master", "default", "system", "computer",
  "summer", "winter", "spring", "autumn", "sommer", "fruehling", "herbst", "january", "januar", "december", "dezember",
  "monday", "montag", "football", "fussball", "baseball", "soccer", "dragon", "monkey", "shadow", "sunshine", "princess",
  "iloveyou", "starwars", "superman", "batman", "pokemon", "freedom", "trustno", "whatever", "michael", "jennifer",
]);

/** Null when the password may be used, else what is wrong with it. */
export function passwordProblem(password: string, username?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  const lower = password.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    return "Password must not contain the user name";
  }
  const word = lower.replace(/@/g, "a").replace(/\$/g, "s").replace(/[^a-z]/g, "");
  if (COMMON.has(word)) return "This password is too easy to guess";
  return null;
}
