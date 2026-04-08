export default class UtonomyConfig {
    static getGeneralSettings() {
        return new Promise((resolve, reject) => {
            chrome.storage.sync.get({
                utonomySettings: {}
            }, (result) => {
                resolve(Object.assign({}, UtonomyConfig.defaultSettings, result.utonomySettings));
            });
        });
    }
    static setGeneralSettings(newGeneralSettings) {
        return new Promise((resolve, reject)=>{
            chrome.storage.sync.set({
                utonomySettings: newGeneralSettings
            }, () => {
                resolve();
            });
        });
    }
}

UtonomyConfig.defaultSettings = {
    "webIdUrl": "",
    "syncTimeStamp": null,
}
