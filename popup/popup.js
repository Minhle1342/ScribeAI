/**
 * popup/popup.js
 * Controls settings saving, API key mask toggling, and broadcasts session resets.
 */

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const deepgramKeyInput = document.getElementById('deepgram-key');
  const modelSelect = document.getElementById('gemini-model');
  const wsUrlInput = document.getElementById('ws-url');
  const toggleKeyBtn = document.getElementById('toggle-key-visibility');
  const toggleDeepgramBtn = document.getElementById('toggle-deepgram-visibility');
  const saveBtn = document.getElementById('save-settings');
  const resetBtn = document.getElementById('reset-session');
  const statusBadge = document.getElementById('status-badge');
  const statusDetail = document.getElementById('status-detail');
  const toast = document.getElementById('toast');

  // Request microphone permission on load to ensure offscreen document capture works
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach(track => track.stop());
        console.log('Microphone permission pre-granted successfully.');
      })
      .catch((err) => {
        console.warn('Microphone permission pre-grant declined or failed:', err);
      });
  }

  // Load current configuration and state
  chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'deepgramApiKey', 'websocketUrl', 'recordingState', 'recordingError'], (data) => {
    if (data.geminiApiKey) {
      apiKeyInput.value = data.geminiApiKey;
    }
    if (data.deepgramApiKey) {
      deepgramKeyInput.value = data.deepgramApiKey;
    }
    if (data.geminiModel) {
      modelSelect.value = data.geminiModel;
    } else {
      modelSelect.value = 'gemini-3.1-flash-lite-preview';
    }
    if (data.websocketUrl) {
      wsUrlInput.value = data.websocketUrl;
    } else {
      wsUrlInput.value = 'ws://localhost:8080/stt';
    }
    
    updateStateUI(data.recordingState || 'IDLE', data.recordingError);
  });

  // Periodically poll or listen for state changes to keep popup reactive
  setInterval(() => {
    chrome.storage.local.get(['recordingState', 'recordingError'], (data) => {
      updateStateUI(data.recordingState || 'IDLE', data.recordingError);
    });
  }, 1000);

  // Toggle API key visibility mask
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '🙈';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '👁️';
    }
  });

  // Toggle Deepgram key visibility mask
  toggleDeepgramBtn.addEventListener('click', () => {
    if (deepgramKeyInput.type === 'password') {
      deepgramKeyInput.type = 'text';
      toggleDeepgramBtn.textContent = '🙈';
    } else {
      deepgramKeyInput.type = 'password';
      toggleDeepgramBtn.textContent = '👁️';
    }
  });

  // Save Settings handler
  saveBtn.addEventListener('click', () => {
    const rawApiKey = apiKeyInput.value.trim();
    const rawDeepgramKey = deepgramKeyInput.value.trim();
    const rawWsUrl = wsUrlInput.value.trim();

    const selectedModel = modelSelect.value;

    // 1. Strict Validation
    if (!rawApiKey) {
      showToast('Error: Gemini API Key is required.', true);
      return;
    }

    if (!rawApiKey.startsWith('AIzaSy')) {
      showToast('Warning: API Key does not appear to be a valid Gemini key format.', true);
    }

    if (!rawWsUrl) {
      showToast('Error: WebSocket STT URL is required.', true);
      return;
    }

    if (!rawWsUrl.startsWith('ws://') && !rawWsUrl.startsWith('wss://')) {
      showToast('Error: URL must begin with ws:// or wss://', true);
      return;
    }

    // 2. Persist to Chrome Local Storage
    chrome.storage.local.set({
      geminiApiKey: rawApiKey,
      geminiModel: selectedModel,
      deepgramApiKey: rawDeepgramKey,
      websocketUrl: rawWsUrl
    }, () => {
      showToast('Settings saved successfully!');
      console.log('Saved configuration.');
    });
  });

  // Reset Session handler
  resetBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear current transcript data and reset meeting status?')) {
      chrome.runtime.sendMessage({ action: 'RESET_MEETING_SESSION' }, (response) => {
        if (response && response.success) {
          showToast('Session reset successfully.');
          updateStateUI('IDLE');
        } else {
          showToast('Reset failed: ' + (response?.error || 'Unknown error'), true);
        }
      });
    }
  });

  /**
   * Refreshes the visual badge and text based on active recording state.
   */
  function updateStateUI(state, errorMsg = null) {
    statusBadge.className = 'badge ' + state.toLowerCase();
    statusBadge.textContent = state;

    switch (state) {
      case 'RECORDING':
        statusDetail.textContent = 'Streaming captured audio to STT server...';
        resetBtn.disabled = true;
        break;
      case 'SUMMARIZING':
        statusDetail.textContent = 'Synthesizing rolling summaries in Gemini API...';
        resetBtn.disabled = true;
        break;
      case 'COMPLETED':
        statusDetail.textContent = 'Intelligence reports generated! View results on page panel.';
        resetBtn.disabled = false;
        break;
      case 'ERROR':
        statusDetail.textContent = `Error: ${errorMsg || 'A pipeline failure occurred.'}`;
        resetBtn.disabled = false;
        break;
      case 'IDLE':
      default:
        statusDetail.textContent = 'Ready to capture meeting audio.';
        resetBtn.disabled = false;
        break;
    }
  }

  /**
   * Triggers a temporary glassmorphic feedback alert bubble.
   */
  function showToast(text, isError = false) {
    toast.textContent = text;
    if (isError) {
      toast.style.background = 'rgba(239, 68, 68, 0.95)';
    } else {
      toast.style.background = 'rgba(16, 185, 129, 0.95)';
    }
    
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2500);
  }
});
