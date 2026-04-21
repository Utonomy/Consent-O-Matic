import GDPRConfig from "./GDPRConfig.js";

const STATUS = {
  INIT: 0,
  NOTHING: 1,
  SEARCHING: 2,
  ERROR: 3,
  HANDLED: 4,
};

// --- Upod OAuth Config (POC) ---
const IDP_SERVER_URL = "http://localhost:3332";
const IDP_WEB_URL = "http://localhost:3001";
const CLIENT_ID = "consent-o-matic-extension";
const REDIRECT_URI = IDP_WEB_URL + "/extension/callback";
const AUTHORIZE_URL = IDP_SERVER_URL + "/auth/oauth2/authorize";
const TOKEN_URL = IDP_SERVER_URL + "/auth/oauth2/token";

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .substring(0, length);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeJwtPayload(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch (e) {
    return null;
  }
}

// Browser compatibility: Use browser API (Firefox) or chrome API (Chrome)
const browserAPI = typeof browser !== "undefined" ? browser : chrome;

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  console.log("Got msg", message);
  try {
    switch (message.split("|")[0]) {
      case "GetTabUrl": {
        reply(sender.tab.url);
        return false;
      }

      case "StartLogin": {
        (async () => {
          try {
            // Generate PKCE parameters
            const codeVerifier = generateRandomString(128);
            const codeChallenge = await generateCodeChallenge(codeVerifier);
            const state = generateRandomString(32);

            // Store state and code verifier for later verification
            await chrome.storage.local.set({
              oauthPending: JSON.stringify({ state, codeVerifier }),
            });

            const redirectUri = browserAPI.identity.getRedirectURL();
            console.log("Generated redirect URI:", redirectUri);

            // Build authorization URL
            const authUrl = new URL(AUTHORIZE_URL);
            authUrl.searchParams.set("client_id", CLIENT_ID);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("state", state);
            authUrl.searchParams.set("code_challenge", codeChallenge);
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("scope", "openid profile email");

            // Launch web auth flow
            chrome.identity.launchWebAuthFlow(
              {
                url: authUrl.toString(),
                interactive: true,
              },
              async (redirectUrl) => {
                if (chrome.runtime.lastError) {
                  console.error("Auth flow error:", chrome.runtime.lastError);
                  reply({ ok: false, error: chrome.runtime.lastError.message });
                  return;
                }

                try {
                  // Parse callback URL
                  const url = new URL(redirectUrl);
                  const code = url.searchParams.get("code");
                  const returnedState = url.searchParams.get("state");
                  const error = url.searchParams.get("error");

                  if (error) {
                    console.error("OAuth error:", error);
                    reply({ ok: false, error });
                    return;
                  }

                  if (!code || !returnedState) {
                    reply({ ok: false, error: "Missing code or state" });
                    return;
                  }

                  // Verify state
                  const stored = await chrome.storage.local.get({
                    oauthPending: null,
                  });
                  const { state: storedState, codeVerifier } = JSON.parse(
                    stored.oauthPending,
                  );

                  if (storedState !== returnedState) {
                    console.error("OAuth state mismatch");
                    reply({ ok: false, error: "State mismatch" });
                    return;
                  }

                  // Exchange code for tokens
                  const tokenResponse = await fetch(TOKEN_URL, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                      grant_type: "authorization_code",
                      code: code,
                      redirect_uri: redirectUri,
                      client_id: CLIENT_ID,
                      code_verifier: codeVerifier,
                    }),
                  });

                  if (!tokenResponse.ok) {
                    const errorText = await tokenResponse.text();
                    console.error(
                      "Token exchange failed:",
                      tokenResponse.status,
                      errorText,
                    );
                    reply({ ok: false, error: "Token exchange failed" });
                    return;
                  }

                  const tokens = await tokenResponse.json();

                  console.log("Received tokens:", tokens);

                  // Store tokens
                  await chrome.storage.local.set({ upodTokens: tokens });
                  await chrome.storage.local.remove("oauthPending");

                  console.log("OAuth login successful");

                  fetch(
                    IDP_SERVER_URL + "/storage/profile?purpose=personalisation",
                    {
                      headers: {
                        Authorization: `Bearer ${tokens.access_token}`,
                      },
                      credentials: "include",
                    },
                  )
                    .then((res) => res.json())
                    .then((profile) => {
                      console.log("Fetched user profile:", profile);
                      // You can store or use the profile information as needed
                    });

                  reply({ ok: true });
                } catch (e) {
                  console.error("OAuth processing error:", e);
                  reply({ ok: false, error: e.message });
                }
              },
            );
          } catch (e) {
            console.error("OAuth initialization error:", e);
            reply({ ok: false, error: e.message });
          }
        })();
        return true;
      }

      // case "EndLogin": {
      //   const receivedData = JSON.parse(message.substring(message.indexOf("|") + 1));
      //   const stored = await chrome.storage.local.get({ oauthPending: null });
      //   const { state: storedState, codeVerifier } = JSON.parse(
      //     stored.oauthPending,
      //   );

      //   if (storedState !== receivedData.state) {
      //     console.error("OAuth state mismatch", stored.oauthPending, receivedData.state);
      //     reply({ ok: false, error: "State mismatch" });
      //     return;
      //   }

      //   chrome.storage.local.remove(["oauthPending"], () => {
      //     reply({ ok: true });
      //   });
      //   return true;
      // }

      case "GetAuthState": {
        chrome.storage.local.get({ upodTokens: null }, (result) => {
          if (result.upodTokens && result.upodTokens.id_token) {
            const user = decodeJwtPayload(result.upodTokens.id_token);
            reply({ loggedIn: true, user: user });
          } else {
            reply({ loggedIn: false, user: null });
          }
        });
        return true;
      }

      case "Logout": {
        chrome.storage.local.remove(["upodTokens", "oauthPending"], () => {
          reply({ ok: true });
        });
        return true;
      }

      case "GetRuleList": {
        GDPRConfig.getDebugValues().then((debugValues) => {
          fetchRules(debugValues.alwaysForceRulesUpdate).then((rules) => {
            reply(rules);
          });
        });
        //Return true to keep reply working after method has ended, async response
        return true;
      }

      case "GetCustomRuleList": {
        GDPRConfig.getCustomRuleLists().then((customRules) => {
          reply(customRules);
        });
        //Return true to keep reply working after method has ended, async response
        return true;
      }

      case "AddCustomRule": {
        let newRule = JSON.parse(message.substring(message.indexOf("|") + 1));

        GDPRConfig.getCustomRuleLists().then((customRules) => {
          let combinedCustomRules = Object.assign({}, customRules, newRule);

          GDPRConfig.setCustomRuleLists(combinedCustomRules);
        });

        return false;
      }

      case "DeleteCustomRule": {
        let deleteRule = message.split("|")[1];

        GDPRConfig.getCustomRuleLists().then((customRules) => {
          delete customRules[deleteRule];

          GDPRConfig.setCustomRuleLists(customRules).then(() => {
            reply();
          });
        });

        return true;
      }

      case "CMPError": {
        if (tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
          setBadgeCheckmark("\u2717", sender.tab.id);
          tabStatusMap.set(sender.tab.id, STATUS.ERROR);
        }
        reply();
        return false;
      }

      case "NothingFound": {
        if (tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
          setBadgeCheckmark("", sender.tab.id);
          tabStatusMap.set(sender.tab.id, STATUS.NOTHING);
        }
        reply();
        return false;
      }

      case "Searching": {
        if (tabStatusMap.get(sender.tab.id) !== STATUS.HANDLED) {
          setBadgeCheckmark("\uD83D\uDD0E", sender.tab.id);
          tabStatusMap.set(sender.tab.id, STATUS.SEARCHING);
        }
        reply();
        return false;
      }

      case "HandledCMP": {
        let json = JSON.parse(message.split("|")[1]);

        setBadgeCheckmark("\u2714", sender.tab.id);

        tabStatusMap.set(sender.tab.id, STATUS.HANDLED);

        GDPRConfig.getStatistics().then((entries) => {
          entries.clicks += json.clicks;

          if (!entries.cmps.hasOwnProperty(json.cmp)) {
            entries.cmps[json.cmp] = {
              filledForms: 0,
              clicks: 0,
            };
          }
          entries.cmps[json.cmp].filledForms++;
          entries.cmps[json.cmp].clicks += json.clicks;

          GDPRConfig.setStatistics(entries);
        });
        reply();
        return false;
      }

      default:
        console.warn("Unhandled message:", message);
    }
  } catch (ex) {
    console.log(ex);
  }
});

function setBadgeCheckmark(text, id) {
  if (chrome.browserAction) {
    if (chrome.browserAction.setBadgeText) {
      chrome.browserAction.setBadgeText({
        text: text,
        tabId: id,
      });
    }
    if (chrome.browserAction.setBadgeBackgroundColor) {
      chrome.browserAction.setBadgeBackgroundColor({
        color: "white",
        tabId: id,
      });
    }
  }
}

function fetchRules(forceUpdate) {
  // Make sure the cached rule-lists are up-to-date, fetch updates if needed
  let maxStaleness = 22 * 3600 + Math.random() * 26 * 3600; // Fetch frequency in seconds
  let rulePromise = new Promise((resolve, reject) => {
    GDPRConfig.getRuleLists().then((ruleLists) => {
      let oldDefaultListIndex = ruleLists.indexOf(
        "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/Rules.json",
      );

      if (oldDefaultListIndex !== -1) {
        console.log(
          "Cleaning old rule list, and replacing with new reference based list...",
        );
        ruleLists[oldDefaultListIndex] =
          "https://raw.githubusercontent.com/cavi-au/Consent-O-Matic/master/rules-list.json";
        GDPRConfig.setRuleLists(ruleLists);
      }

      chrome.storage.local.get(
        { cachedEntries: {} },
        async function ({ cachedEntries: cachedEntries }) {
          let rules = [];
          for (let ruleList of ruleLists) {
            let entry = cachedEntries[ruleList];

            // Check for cache
            if (
              !forceUpdate &&
              entry != null &&
              "timestamp" in entry &&
              Date.now() / 1000 - entry.timestamp < maxStaleness &&
              "rules" in entry
            ) {
              rules.push(entry.rules);
            } else {
              // No cache, or to old, try to fetch
              let theList = await fetchRulesList(ruleList);

              if (theList != null) {
                let storedEntry = {};
                rules.push(theList);
                cachedEntries[ruleList] = {
                  timestamp: Date.now() / 1000,
                  rules: theList,
                };
              } else {
                //Reuse cached entry even though its out of date at this point
                console.log(
                  "Failed to fetch CoM rule list, check the URL",
                  ruleList,
                );
                if (entry != null) {
                  rules.push(entry.rules);
                } else {
                  console.log(
                    "Giving up entirely on rule list, no cache available either",
                    ruleList,
                  );
                }
              }
            }
          }

          chrome.storage.local.set(
            {
              cachedEntries: cachedEntries,
            },
            () => {
              resolve(rules);
            },
          );
        },
      );
    });
  });

  return rulePromise;
}

let tabStatusMap = new Map();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  console.log("Tab updated", tabId, info, tab);
  if (info.status != null && info.status === "Loading") {
    setBadgeCheckmark("", tabId);
    tabStatusMap.set(tabId, STATUS.INIT);
  }
  // OAuth callback interception
  // if (tab.url && tab.url.startsWith(REDIRECT_URI)) {
  //   console.log("OAuth callback detected, processing...", tab.url);
  //   (async () => {
  //     try {
  //       const url = new URL(tab.url);
  //       const code = url.searchParams.get("code");
  //       const state = url.searchParams.get("state");
  //       const error = url.searchParams.get("error");

  //       if (error) {
  //         console.error("OAuth error:", error);
  //         return;
  //       }

  //       if (!code || !state) return;

  //       const stored = await chrome.storage.local.get({ oauthPending: null });
  //       console.log("Stored OAuth pending:", stored);
  //       const { state: storedState, codeVerifier } = JSON.parse(
  //         stored.oauthPending,
  //       );
  //       if (storedState !== state) {
  //         console.error("OAuth state mismatch", stored.oauthPending, state);
  //         return;
  //       }

  //       const tokenResponse = await fetch(TOKEN_URL, {
  //         method: "POST",
  //         headers: { "Content-Type": "application/x-www-form-urlencoded" },
  //         body: new URLSearchParams({
  //           grant_type: "authorization_code",
  //           code: code,
  //           redirect_uri: REDIRECT_URI,
  //           client_id: CLIENT_ID,
  //           code_verifier: codeVerifier,
  //         }),
  //       });

  //       if (!tokenResponse.ok) {
  //         console.error(
  //           "Token exchange failed:",
  //           tokenResponse.status,
  //           await tokenResponse.text(),
  //         );
  //         return;
  //       }

  //       const tokens = await tokenResponse.text();
  //       await chrome.storage.local.set({ upodTokens: tokens });
  //       await chrome.storage.local.remove("oauthPending");
  //       console.log("OAuth login successful");

  //       // Close the callback tab
  //       chrome.tabs.remove(tabId);
  //     } catch (e) {
  //       console.error("OAuth callback error:", e);
  //     }
  //   })();
  // }
});

async function fetchRulesList(ruleList) {
  try {
    let response = await fetch(ruleList, { cache: "no-store" });
    let theList = await response.json();

    let theMergedList = Object.assign({}, theList);
    delete theMergedList.references;

    //If references is present, fetch those and merge into big json object
    if (theList.references != null) {
      let promises = [];
      for (let ref of theList.references) {
        promises.push(fetchRulesList(ref));
      }

      let lists = await Promise.all(promises);

      lists.forEach((list) => {
        Object.assign(theMergedList, list);
      });
    }

    return theMergedList;
  } catch (e) {
    console.warn("Error fetching rulelist: ", ruleList, e.message);
  }

  return null;
}

// Show onboarding page on first load
GDPRConfig.getDebugValues().then((config) => {
  if (config.autoOpenOptionsTab) {
    config.autoOpenOptionsTab = false;
    GDPRConfig.setDebugValues(config);
    chrome.tabs.create(
      { url: chrome.runtime.getURL("options.html") },
      function (tab) {
        console.log("Launched initial onboarding page");
      },
    );
  }
});
