// Sign in / create account page. Uses Firebase Auth through window.tinkerCloud (firebase.js).

const cloud = window.tinkerCloud;
const $ = (id) => document.getElementById(id);
lucide.createIcons();

let mode = "signin"; // or "signup"
let busy = false;

// Only allow going back to a page on this site (never to another website).
const next = new URLSearchParams(location.search).get("next");
const goNext = () => location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/app");

// Firebase error codes → plain language.
const MESSAGES = {
  "auth/invalid-credential": "That email and password don't match. Check them, or create an account.",
  "auth/wrong-password": "That email and password don't match.",
  "auth/user-not-found": "No account with that email yet. Switch to Create account.",
  "auth/email-already-in-use": "There's already an account with this email. Sign in instead.",
  "auth/weak-password": "Please use at least 6 characters for your password.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again, or reset your password.",
  "auth/network-request-failed": "Couldn't reach the sign-in service. Check your internet.",
  "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups for this site and try again.",
  "auth/unauthorized-domain": "This website isn't allowed to sign in yet (Firebase → Authentication → Settings → Authorized domains).",
  "auth/operation-not-allowed": "This sign-in method isn't switched on yet (Firebase → Authentication → Sign-in method).",
};
const friendly = (error) => MESSAGES[error?.code] || `Something went wrong (${error?.code || error?.message}). Please try again.`;

function setMode(newMode) {
  mode = newMode;
  const signup = mode === "signup";
  $("tab-signin").setAttribute("aria-selected", String(!signup));
  $("tab-signup").setAttribute("aria-selected", String(signup));
  $("tab-signin").tabIndex = signup ? -1 : 0;
  $("tab-signup").tabIndex = signup ? 0 : -1;
  $("name-field").hidden = !signup;
  $("password-hint").hidden = !signup;
  $("forgot").hidden = signup;
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("submit-label").textContent = signup ? "Create account" : "Sign in";
  $("google-label").textContent = signup ? "Sign up with Google" : "Continue with Google";
  $("auth-title").textContent = signup ? "Create your account" : "Welcome back";
  clearErrors();
}

function clearErrors() {
  for (const id of ["email-error", "password-error", "form-message"]) $(id).textContent = "";
  $("form-message").className = "form-message";
  $("email").removeAttribute("aria-invalid");
  $("password").removeAttribute("aria-invalid");
}

function fieldError(field, message) {
  $(`${field}-error`).textContent = message;
  $(field).setAttribute("aria-invalid", "true");
}

function setBusy(value, button) {
  busy = value;
  for (const b of [$("submit"), $("google")]) b.disabled = value;
  button?.classList.toggle("loading", value);
}

// ---------- Tabs (click + arrow keys) ----------
$("tab-signin").onclick = () => setMode("signin");
$("tab-signup").onclick = () => setMode("signup");
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const target = mode === "signin" ? "signup" : "signin";
  setMode(target);
  $(`tab-${target}`).focus();
});

// ---------- Show / hide password ----------
$("toggle-password").onclick = () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("toggle-password").setAttribute("aria-pressed", String(show));
  $("toggle-password").setAttribute("aria-label", show ? "Hide password" : "Show password");
  $("toggle-password").innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`;
  lucide.createIcons();
};

// ---------- Google ----------
$("google").onclick = async () => {
  if (busy) return;
  clearErrors();
  setBusy(true, $("google"));
  try {
    await cloud.signIn();
    goNext();
  } catch (error) {
    if (error?.code !== "auth/popup-closed-by-user" && error?.code !== "auth/cancelled-popup-request") $("form-message").textContent = friendly(error);
    setBusy(false, $("google"));
  }
};

// ---------- Email + password ----------
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  clearErrors();
  const email = $("email").value.trim();
  const password = $("password").value;
  let ok = true;
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    fieldError("email", "Enter your email address, like you@example.com.");
    ok = false;
  }
  if (password.length < 6) {
    fieldError("password", mode === "signup" ? "Use at least 6 characters." : "Enter your password.");
    ok = false;
  }
  if (!ok) {
    document.querySelector("[aria-invalid=true]").focus();
    return;
  }

  setBusy(true, $("submit"));
  try {
    if (mode === "signup") await cloud.signUpWithEmail($("name").value.trim(), email, password);
    else await cloud.signInWithEmail(email, password);
    goNext();
  } catch (error) {
    $("form-message").textContent = friendly(error);
    setBusy(false, $("submit"));
  }
};

// ---------- Forgot password ----------
$("forgot").onclick = async () => {
  clearErrors();
  const email = $("email").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    fieldError("email", "Type your email first, then click Forgot password.");
    $("email").focus();
    return;
  }
  try {
    await cloud.resetPassword(email);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      $("form-message").textContent = friendly(error);
      return;
    }
  }
  // Same message whether or not the account exists, so nobody can check which emails have accounts.
  $("form-message").className = "form-message success";
  $("form-message").textContent = `If there's an account for ${email}, a reset link is on its way. Check your inbox.`;
};

// ---------- Already signed in? ----------
cloud.onUserChange((user) => {
  if (busy) return; // we're signing in right now and will redirect
  $("signed-in").hidden = !user;
  $("auth-forms").hidden = Boolean(user);
  if (user) $("signed-in-as").textContent = `Signed in as ${user.email || user.displayName}.`;
});
$("sign-out").onclick = () => cloud.signOut();

setMode(new URLSearchParams(location.search).get("mode") === "signup" ? "signup" : "signin");
