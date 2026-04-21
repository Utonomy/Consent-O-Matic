const loadingEl = document.querySelector("#loading");
const loggedOutEl = document.querySelector("#logged-out");
const loggedInEl = document.querySelector("#logged-in");

if (loadingEl) {
  // Check auth state on popup open
  chrome.runtime.sendMessage("GetAuthState", null, (response) => {
    loadingEl.classList.add("hidden");

    if (response && response.loggedIn) {
      const user = response.user;
      const nameEl = document.querySelector("#user-name");
      const emailEl = document.querySelector("#user-email");

      if (nameEl) nameEl.textContent = user?.name || "Logged in";
      if (emailEl) emailEl.textContent = user?.email || "";

      loggedInEl.classList.remove("hidden");
    } else {
      loggedOutEl.classList.remove("hidden");
    }
  });

  // Login button
  document.querySelector("#login-btn")?.addEventListener("click", () => {
    console.log("Login button clicked, sending StartLogin message");
    chrome.runtime.sendMessage("StartLogin", null, () => {
      window.close();
    });
  });

  // Logout button
  document.querySelector("#logout-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage("Logout", null, () => {
      loggedInEl.classList.add("hidden");
      loggedOutEl.classList.remove("hidden");
    });
  });

  // Settings buttons
  document.querySelector("#settings-btn-out")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  document.querySelector("#settings-btn-in")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}
