// Content script for Translation to Speech extension
(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__betterControlsSocialMediaInjected) {
    return;
  }
  window.__betterControlsSocialMediaInjected = true;

  class Dom {
    get videos() {
      return document.querySelectorAll('video');
    }

    get body() {
      return document.querySelector('body');
    }
  }

  class VideoData {
    constructor(data = {}) {
      this._volume = data.volume ?? 0.5;
      this.muted = data.muted ?? true;
    }

    get volume() {
      return this._volume;
    }

    set volume(value) {
      this._volume = this.#validateVolume(value);
    }

    #validateVolume(volume) {
        const num = parseFloat(volume);
        return (num >= 0 && num <= 1) ? num : 0.5;
    }

    toJSON() {
        return {
            volume: this.volume,
            muted: this.muted
        };
    }
  }

  class VideoDataStorage {
    static STORAGE_KEY = 'better-controls-social-media-data';

    constructor() {
      this.cachedDataObject = null;
    }

    async save(dataObject) {
      try {
        const jsonString = JSON.stringify(dataObject.toJSON());
        
        if (chrome?.storage?.local) {
          chrome.storage.local.set({
            [VideoDataStorage.STORAGE_KEY]: dataObject.toJSON()
          });
        }
        
        if (this.cachedDataObject != dataObject) {
          this.cachedDataObject = dataObject;
        }

        return true;
      } catch (error) {
        console.error('Failed to save data: ', error, dataObject);
        return false;
      }
    }

    async load({ force = false } = {}) {
      if (!force && this.cachedDataObject) {
        return this.cachedDataObject;
      }

      let json = null;
      try {
        if (chrome?.storage?.local) {
          json = await chrome.storage.local.get([VideoDataStorage.STORAGE_KEY]);
        }

        if (json) {
          this.cachedDataObject = new VideoData(json[VideoDataStorage.STORAGE_KEY]);
          return this.cachedDataObject;
        }
      } catch (error) {
        console.error('Failed to load data:', error, json);
      }
      
      this.cachedDataObject = new VideoData();
      return this.cachedDataObject;
    }

    addOnChangeListener(listener) {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.onChanged.addListener((changes) => {
            if (Object.keys(changes).some((item) => item === VideoDataStorage.STORAGE_KEY)) {
              listener(changes[VideoDataStorage.STORAGE_KEY]);
            }
          })
        }
      } catch (error) {
        console.error('Failed to add listener:', error);
      }
    }
  }

  class VolumeController {
    constructor(videoElement, onUserVolumeChange) {
      this.video = videoElement;
      this.onUserVolumeChange = onUserVolumeChange;
      this.isChangingVolumeProgrammatically = false;
      
      this.#setupVolumeListener();
    }

    #setupVolumeListener() {
      let debounceTimer;
      this.video.addEventListener('volumechange', (event) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (this.isChangingVolumeProgrammatically) {
            return;
          }

          const volume = this.video.volume;
          const muted = this.video.muted;

          this.onUserVolumeChange(volume, muted);
        }, 150);
      });
    }

    setVolume({ volume, muted } = {}) {
      this.isChangingVolumeProgrammatically = true;

      if (volume != undefined && this.volume != volume) {
        this.video.volume = volume;
      }
      if (muted != undefined) {
        this.video.muted = muted;
      }

      setTimeout(() => {
          this.isChangingVolumeProgrammatically = false;
      }, 200);
    }
}

  const dom = new Dom();
  const videoDataStorage = new VideoDataStorage();
  let debounceTimer;
  let allMutations = new Array();

  const pageStateObserver = new MutationObserver((mutations) => {
    const hasInitPage = mutations.some((mutation) => {
      return Array.from(mutation.addedNodes).some(node => 
          node.nodeName === 'DIV'
        );
    });
    if (hasInitPage) {
      pageStateObserver.disconnect();
      init();
    }
  });

  const infiniteLoaderObserver = new MutationObserver((mutations) => {
    allMutations.push(mutations);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const volumeData = await videoDataStorage.load();
      allMutations.forEach((mutations) =>
        mutations.forEach((mutation) => {
          if (mutation.addedNodes.length > 0) {
            const newNodes = Array.from(mutation.addedNodes).filter(node => 
              Array.from(node.children).some((child) => 
                child.querySelector('video')
              )
            );
            if (newNodes.length > 0) {
              Array.from(newNodes).forEach((node) => {
                const newVideos = node.querySelectorAll('video');
                Array.from(newVideos).forEach((video) => enhanceVideo(video, volumeData))
              });
            }
          }
        })
      );
      allMutations = new Array();
    }, 150);
  });

  async function init() {
    const body = dom.body;

    if (body) {
      const videos = dom.videos;

      const volumeData = await videoDataStorage.load();
      Array.from(videos).forEach((video) => enhanceVideo(video, volumeData));

      infiniteLoaderObserver.observe(body, {
        childList: true,
        subtree: true
      });

      videoDataStorage.addOnChangeListener(async (change) => {
        const volumeData = await videoDataStorage.load({ force: true });
        const videos = dom.videos;

        Array.from(videos).forEach((video) => restoreVolume(video, volumeData));
      });
    }
  }

  function enhanceVideo(video, volumeData) {
    if (!video.hasAttribute('better-controls')) {
      removeOverlay(video);
      addControls(video);
      addVolumeController(video);
      restoreVolume(video, volumeData);

      video.setAttribute('better-controls', '');
    }
  }

  function removeOverlay(video) {
    Array.from(video.parentElement.children)
      .forEach((element) => {
        if (element.tagName != 'VIDEO') {
          element.remove();
        }
      });
  }

  function addControls(video) {
    video.setAttribute('controls', '');
  }

  function addVolumeController(video) {
    const volumeController = new VolumeController(
      video,
      async (volume, muted) => {
        const videoData = new VideoData({
          volume: volume,
          muted: muted
        });
        await videoDataStorage.save(videoData);
      }
    );
    video.addEventListener('play', (event) => {
      setTimeout(async () => {
        const volumeData = await videoDataStorage.load();
        if (video.volumeController) {
          video.volumeController.setVolume({ muted: volumeData.muted });
        }
      }, 10);
    });
    video.volumeController = volumeController;
  }

  function restoreVolume(video, volumeData) {
    if (video.volumeController) {
      video.volumeController.setVolume({
        volume: volumeData.volume,
        muted: volumeData.muted
      });
    }
  }

  let videos = dom.videos;
  if (!videos) {
    pageStateObserver.observe(dom.body, {
      childList: true,
      subtree: true
    });
  } else {
    init();
  }
})();