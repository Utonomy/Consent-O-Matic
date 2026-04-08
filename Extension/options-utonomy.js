import GDPRConfig from './GDPRConfig'
import UtonomyConfig from './UtonomyConfig'
import Language from './Language.js'
import '@muze-nl/metro-oidc'
import '@muze-nl/metro-oldm'

const SESSION_KEY = {
    issuer: 'utonomy:solidIssuer',
    storageUrl: 'utonomy:solidStorageUrl',
}

const CONNECTION_STATUS = {
    connected: 'connected',
    connecting: 'connecting',
    error: 'error',
}


const webidConfig = {
    prefixes: {
        foaf: 'http://xmlns.com/foaf/0.1/',
        solid: 'http://www.w3.org/ns/solid/terms#',
        space: 'http://www.w3.org/ns/pim/space#',
    }, parser: oldm.n3Parser,
}

const solidConfig = {
    client_info: {
        client_name: 'Utonomy Consent-O-Matic',
        redirect_uris: [ location.origin + location.pathname ],
    },
    // authorize_callback: metro.oauth2.authorizePopup,
    force_authorization: true,
}

// Mutable config – issuer is set after WebID resolution, before first fetchResource call
const config = { ...webidConfig, ...solidConfig }

let client = null

async function fetchResource(resourceURL, config) {
    let data

    const client = getMetroClient(config)

    const response = await client.get(resourceURL)

    if (response.data !== response.body) {
        // When oldm middleware is used (and the response can be parsed to a LinkedData Object)
        // a Linked Data object is returned. This avoids the need to parse the response ourselves
        console.log('Response is a LinkedData Object', response, response.data)
        data = response.data
    } else if (response instanceof ReadableStream) {
        // When the getdata middleware is added, the client returns a ReadableStream
        console.log('Response is a ReadableStream', response)
        for await (const chunk of response) {
            data += new TextDecoder().decode(chunk)
        }
    } else if (response instanceof Response) {
        // If no middleware is used, the client returns a Response object
        console.log('Response is a Response Object', response)
        data = await response.text()
    } else {
        alert('Unknown response type')
        data = response
    }

    return data
}

async function fetchWebId(webIdURL) {
    const client = metro.client(
        metro.mw.thrower(),
        oldmmw(config),
        metro.mw.getdata(),
    )

    const linkedData = await client.get(webIdURL)

    if ( ! linkedData.primary) {
        throw new Error('No primary resource found in WebID')
    }

    let primary = linkedData.primary
    // Follow foaf:primaryTopic if present (most WebID profiles)
    if (primary['foaf$primaryTopic']) {
        primary = primary['foaf$primaryTopic']
    }

    return primary
}

function getMetroClient(config) {
    if ( ! client) {
        client = metro.client(
            metro.oidc.oidcmw(config),
            metro.mw.thrower(),
            // oldmmw(config),
            // metro.mw.getdata(), (?)
        )
    }

    return client
}

let webIdInput = document.querySelector('#webIdUrl')
let solidConnectButton = document.querySelector('#solidConnect')
let connectionStatus = document.querySelector('#connectionStatus')

if (webIdInput) {
    // Error: www-authenticate
    // 	Bearer realm="https://solidcommunity.net/", error="invalid_redirect_uri", error_description="redirect_uris must only contain web uris"

    // There are several paths through the logic
    // The starting situation is that the user has not filed in a WebID, and there are no settings (other than default)
    // Before they can continue, the user needs to fill in a WebID.
    // Once there is a WebID, the "Connect" button is shown.
    // When connecting there are the following possible scenario's:
    //
    // 1.  This is the first time the user connects
    // 2.  The user has already connected before, but not provided settings yet
    // 3.  The user has already connected before, and provided settings
    //
    // When the user is connected and  there are settings provided, we only need to fetch them, and write them to GDPROptions.
    //
    // During the connection flow, there is an OIDC redirect.
    let states = {
        webId: false, // when `true` show connect button
        connecting: false, // when `true` we are in the middle of the OIDC flow, and should not show the connect button
        connected: false, // until `true` the user can not continue
        hasSettings: false, // when `false` we still need to fetch the settings. If `true` the settings have been provided via browser sync. We still need to fetch to check the synced settings to remote
        fetchSettings: false, // when `true` a fetch has been attempted, but settings might not be present
    }
    UtonomyConfig.getGeneralSettings().then(async (generalSettings) => {
        let webIdUrl = generalSettings.webIdUrl
        console.log('[Utonomy] Setting WebID from stored config', webIdUrl)

        webIdInput.value = generalSettings.webIdUrl || ''

        function saveGeneralSettings(webIdUrl, syncTimeStamp) {
            console.log('Saving Utonomy settings', { webIdUrl, syncTimeStamp })
            const newUtonomySettings = {
                webIdUrl: webIdUrl.trim(),
                syncTimeStamp: syncTimeStamp,
            }

            UtonomyConfig.setGeneralSettings(newUtonomySettings)
        }

        function updateConnectionStatus(status, timestamp = null) {
            console.log('[Utonomy] Connection status:', status)
            connectionStatus.dataset.status = status

            if (status === CONNECTION_STATUS.connected) {
                connectionStatus.innerHTML = '✅'
                connectionStatus.title = `Connected ${timestamp}`
            } else if (status === CONNECTION_STATUS.connecting) {
                connectionStatus.innerHTML = '⏳'
                connectionStatus.title = `Connecting...`
            } else {
                connectionStatus.innerHTML = '❌'
                connectionStatus.title = 'Error while connecting'
            }
        }

        async function handleStorage(storageUrl, consentTypes) {
            // @TODO: Decide which path to store config data
            const url = storageUrl
                + (storageUrl.endsWith('/') ? '' : '/')
                + 'utonomy/consent-o-matic.json'

            let resource

            let exists = false

            let shouldWriteToLocal = false
            let shouldWriteToRemote = false

            updateConnectionStatus(CONNECTION_STATUS.connecting)

            try {
                // If not authenticated this will redirect to the Solid IdP;
                // if already authenticated it returns the pod resource directly.
                resource = await fetchResource(url, config)
                exists = true
                try {
                    resource = JSON.parse(resource)
                    shouldWriteToLocal = true
                } catch (e) {
                    // content is not valid JSON
                    shouldWriteToLocal = false
                }

                console.log('[Utonomy] Pod resource:', resource)

                let syncTimeStamp = new Date().toISOString()
                updateConnectionStatus(CONNECTION_STATUS.connected, syncTimeStamp)
                saveGeneralSettings(webIdUrl, syncTimeStamp)

                if (shouldWriteToLocal) {
                    GDPRConfig.setConsentValues(resource.consentTypes)
                }
            } catch (e) {
                // A 401 or 403 should not happen, as the user _should_ already be logged in
                if (e.response && e.response.status === 404 || e.message && e.message.includes('404')) {
                    shouldWriteToRemote = true
                } else {
                    console.error('[Utonomy] Error fetching resource:', e)
                    updateConnectionStatus(CONNECTION_STATUS.error)
                }
            }

            // If the resource is empty we also need to write it
            // (or incorrect, but that is for later),

            if (shouldWriteToRemote) {
                resource = { consentTypes }
                const content = JSON.stringify(resource, null, 4)
                let result
                console.log('[Utonomy] Writing config to pod at', url, 'with content:', content)

                const client = getMetroClient(config)
                if (exists) {
                    result = await client.put(url, {
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                        body: content,
                })

                } else {
                    result = await client.post(url, {
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                        body: content,
                    })
                }

                console.log('[Utonomy] Put resource:', result)
                updateConnectionStatus(CONNECTION_STATUS.connected, new Date().toISOString())
            }

            return resource
        }

        // --- Branch A: we are back from the OIDC redirect ---
        if (metro.oidc.isRedirected()) {
            const storageUrl = sessionStorage.getItem(SESSION_KEY.storageUrl)
            const issuer = sessionStorage.getItem(SESSION_KEY.issuer)

            sessionStorage.removeItem(SESSION_KEY.storageUrl)
            sessionStorage.removeItem(SESSION_KEY.issuer)

            if (storageUrl && issuer) {
                config.issuer = issuer

                GDPRConfig.getConsentValues().then(async (consentTypes) => {
                    console.log('[Utonomy] Pod resource (post-login):', consentTypes)
                    handleStorage(storageUrl, consentTypes)
                })

            }
            // Module parse failed: 'return' outside of function (136:8)
        } else {
            // --- Branch B: normal page load – show the WebID connect form ---
            console.log('[Utonomy] Solid OIDC client config:', config)

            function updateConnectButton(value) {
                solidConnectButton.hidden = ! value
                try {
                    new URL(webIdInput.value)
                    solidConnectButton.disabled = false
                    solidConnectButton.style.opacity = 1
                } catch (e) {
                    solidConnectButton.disabled = true
                    solidConnectButton.style.opacity = 0.5
                }
            }

            webIdInput.addEventListener('input', () => {
                saveGeneralSettings(webIdInput.value, generalSettings.syncTimeStamp)
                updateConnectButton(webIdInput.value)
            })

            if (solidConnectButton !== null) {
                console.log('[Utonomy] WebID URL:', webIdUrl)
                console.log('[Utonomy] General settings:', generalSettings)
                updateConnectButton(webIdUrl)
                if (generalSettings.syncTimeStamp) {
                    updateConnectionStatus(CONNECTION_STATUS.connected, generalSettings.syncTimeStamp)
                }

                solidConnectButton.addEventListener('click', async () => {
                    if ( ! webIdUrl && webIdInput.value) {
                        webIdUrl = webIdInput.value.trim()
                    }

                    if ( ! webIdUrl) {
                        alert('[Utonomy] Please enter a WebID URL before trying to connect')
                    } else {
                        const webid = await fetchWebId(webIdUrl)

                        const issuer = webid['solid$oidcIssuer']?.id
                        const storageUrl = webid['space$storage']?.id

                        if ( ! issuer) {
                            throw new Error('[Utonomy] No OIDC issuer found in WebID')
                        } else if ( ! storageUrl) {
                            throw new Error('[Utonomy] No storage URL found in WebID')
                        } else {
                            config.issuer = issuer

                            console.log('[Utonomy] Issuer:', issuer)
                            console.log('[Utonomy] Storage URL:', storageUrl)

                            // Persist across the redirect so Branch A can pick them up
                            sessionStorage.setItem(SESSION_KEY.storageUrl, storageUrl)
                            sessionStorage.setItem(SESSION_KEY.issuer, issuer)

                            GDPRConfig.getConsentValues().then(async (consentTypes) => {
                                console.log('[Utonomy] Consent values:', consentTypes)
                                handleStorage(storageUrl, consentTypes)
                            })
                        }
                    }
                })
            }
        }
    })

    // @TODO: Check if we need to show the onboarding permissions panel

    Language.doLanguage()
}
