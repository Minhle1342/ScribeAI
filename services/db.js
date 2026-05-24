/**
 * services/db.js
 * Highly robust, lightweight wrapper for IndexedDB to manage transcribed meeting text.
 * Runs inside the extension background worker, offscreen document, or popups.
 */

const DB_NAME = 'GeminiMeetingRecorderDB';
const DB_VERSION = 1;
const STORE_NAME = 'transcript_chunks';

/**
 * Open or initialize the IndexedDB connection.
 * @returns {Promise<IDBDatabase>}
 */
function openMeetingDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(new Error(`Failed to open IndexedDB: ${event.target.error?.message}`));
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Create store with an auto-incrementing key
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        console.log(`IndexedDB Object Store "${STORE_NAME}" created successfully.`);
      }
    };
  });
}

/**
 * Append a newly received text chunk to the database.
 * @param {string} text The raw text transcribed from the audio chunk.
 * @returns {Promise<number>} Resolves with the generated chunk ID.
 */
async function saveTranscriptChunk(text) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const db = await openMeetingDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const chunk = {
      text: text.trim(),
      timestamp: Date.now()
    };

    const request = store.add(chunk);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = (event) => {
      console.error('Failed to save chunk to IndexedDB:', event.target.error);
      reject(new Error(`Save chunk failed: ${event.target.error?.message}`));
    };
  });
}

/**
 * Retrieve all transcribed chunks from the database in chronological order.
 * @returns {Promise<Array<{id: number, text: string, timestamp: number}>>}
 */
async function getAllTranscriptChunks() {
  const db = await openMeetingDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll(); // IndexedDB auto-increments key chronologically

    request.onsuccess = () => {
      resolve(request.result || []);
    };

    request.onerror = (event) => {
      console.error('Failed to retrieve chunks from IndexedDB:', event.target.error);
      reject(new Error(`Retrieve chunks failed: ${event.target.error?.message}`));
    };
  });
}

/**
 * Build the full transcript string by joining all recorded chunks.
 * @returns {Promise<string>}
 */
async function getCompiledTranscript() {
  try {
    const chunks = await getAllTranscriptChunks();
    return chunks.map(chunk => chunk.text).join(' ');
  } catch (error) {
    console.error('Failed to compile full transcript:', error);
    return '';
  }
}

/**
 * Clear all records in the transcript chunks database.
 * @returns {Promise<void>}
 */
async function clearTranscriptDatabase() {
  const db = await openMeetingDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => {
      console.log('IndexedDB transcript database cleared successfully.');
      resolve();
    };

    request.onerror = (event) => {
      console.error('Failed to clear database:', event.target.error);
      reject(new Error(`Clear database failed: ${event.target.error?.message}`));
    };
  });
}

// Export functions for ES modules, or leave on global scope for standard script injections
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    openMeetingDB,
    saveTranscriptChunk,
    getAllTranscriptChunks,
    getCompiledTranscript,
    clearTranscriptDatabase
  };
} else {
  // Bind to global scope (window or self) for content scripts or background service workers
  const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this);
  globalScope.meetingDB = {
    openMeetingDB,
    saveTranscriptChunk,
    getAllTranscriptChunks,
    getCompiledTranscript,
    clearTranscriptDatabase
  };
}
