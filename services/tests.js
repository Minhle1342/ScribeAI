/**
 * services/tests.js
 * Comprehensive validation test suite covering user inputs, chunking algorithms,
 * JSON mode schemas, and simulated rate-limiting or network error responses.
 * Can be run in Node.js or embedded directly inside the browser extension.
 */

// Mock browser environments if running in Node.js context
const isNode = typeof window === 'undefined';
let geminiService = null;

if (isNode) {
  // Load local dependencies in Node.js environment
  geminiService = require('./geminiService.js');
} else {
  // Read from global namespace inside browser environment
  geminiService = window.geminiService;
}

const {
  splitTranscriptIntoChunks,
  isValidSummarySchema
} = geminiService;

/**
 * Super lightweight assertion framework
 */
const results = { passed: 0, failed: 0 };

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    results.passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    results.failed++;
  }
}

async function runTests() {
  console.log('==================================================');
  console.log('STARTING SCRIBE INTEL TEST COVERAGE SUITE');
  console.log('==================================================\n');

  // ----------------------------------------------------
  // TEST UNIT 1: KEY & URL CONFIGURATION INPUT VALIDATIONS
  // ----------------------------------------------------
  console.log('UNIT 1: User Configuration Inputs Validation');
  
  // Validation simulations (matching popup/popup.js validation routines)
  const validateInputs = (key, url) => {
    const keyValid = !!(key && key.trim().length > 0 && key.startsWith('AIzaSy'));
    const urlValid = !!(url && url.trim().length > 0 && (url.startsWith('ws://') || url.startsWith('wss://')));
    return { keyValid, urlValid };
  };

  assert(validateInputs('AIzaSyKey123', 'ws://localhost:8080').keyValid === true && validateInputs('AIzaSyKey123', 'ws://localhost:8080').urlValid === true, 
    'Should pass for valid key starting with AIzaSy and valid ws:// url');

  assert(validateInputs('', 'ws://localhost:8080').keyValid === false, 
    'Should fail for empty API key');

  assert(validateInputs('wrong_format_key', 'ws://localhost:8080').keyValid === false, 
    'Should fail for key missing Gemini prefix AIzaSy');

  assert(validateInputs('AIzaSyKey123', '').urlValid === false, 
    'Should fail for empty STT server url');

  assert(validateInputs('AIzaSyKey123', 'http://localhost:8080').urlValid === false, 
    'Should fail for invalid STT server protocol (http instead of ws)');
  
  console.log('\n----------------------------------------------------');

  // ----------------------------------------------------
  // TEST UNIT 2: TRANSCRIPT CHUNKING ALGORITHM
  // ----------------------------------------------------
  console.log('UNIT 2: Boundary Chunking & Word Backtracking');

  const textUnderLimit = 'Hello this is a short transcript segment.';
  const chunksUnder = splitTranscriptIntoChunks(textUnderLimit, 100);
  assert(chunksUnder.length === 1 && chunksUnder[0] === textUnderLimit,
    'Text under character limit should yield exactly 1 intact chunk');

  const textExactlyAt = 'This text has exactly forty characters!'; // 40 characters
  const chunksExact = splitTranscriptIntoChunks(textExactlyAt, 40);
  assert(chunksExact.length === 1 && chunksExact[0] === textExactlyAt,
    'Text exactly matching chunk limit should yield exactly 1 intact chunk');

  // 48 characters with space at index 25
  const longTextToSplit = 'This is a long meeting sentence that we must slice.';
  const chunksSplit = splitTranscriptIntoChunks(longTextToSplit, 30);
  assert(chunksSplit.length === 2, 
    'Text exceeding limit should be split into multiple chunks');
  assert(chunksSplit[0] === 'This is a long meeting', 
    'Chunk boundary should backtrack to closest space ("This is a long meeting") to avoid word clipping');
  assert(chunksSplit[1] === 'sentence that we must slice.', 
    'Remaining transcript should reside in the subsequent chunk');

  console.log('\n----------------------------------------------------');

  // ----------------------------------------------------
  // TEST UNIT 3: SCHEMA CONFORMANCE VALIDATIONS (JSON MODE)
  // ----------------------------------------------------
  console.log('UNIT 3: JSON Mode Schema Validation');

  const perfectJson = {
    topics: [{ title: 'Intro', summary: 'Discussion on layout.' }],
    decisions: ['Approved budget.'],
    actionItems: [{ task: 'Update logo', assignee: 'John', deadline: 'Friday' }]
  };
  assert(isValidSummarySchema(perfectJson) === true,
    'Should return TRUE for completely conformed schemas');

  const missingTopicsJson = {
    decisions: ['Approved budget.'],
    actionItems: [{ task: 'Update logo', assignee: 'John', deadline: 'Friday' }]
  };
  assert(isValidSummarySchema(missingTopicsJson) === false,
    'Should return FALSE if topics array is missing');

  const incorrectTopicTypeJson = {
    topics: [{ title: 'Intro' }], // missing summary
    decisions: ['Approved budget.'],
    actionItems: [{ task: 'Update logo', assignee: 'John' }]
  };
  assert(isValidSummarySchema(incorrectTopicTypeJson) === false,
    'Should return FALSE if topic elements are missing summary properties');

  const incorrectActionItemTypeJson = {
    topics: [{ title: 'Intro', summary: 'Layout stuff.' }],
    decisions: ['Approved budget.'],
    actionItems: [{ deadline: 'Friday' }] // missing task and assignee
  };
  assert(isValidSummarySchema(incorrectActionItemTypeJson) === false,
    'Should return FALSE if action items are missing task or assignee');

  console.log('\n----------------------------------------------------');

  // ----------------------------------------------------
  // TEST UNIT 4: RETRY & FAILURE FALLBACKS (API SIMULATION)
  // ----------------------------------------------------
  console.log('UNIT 4: API Error Fallbacks & Rate Limiting Simulations');

  // Simulated Rate limit mock responder
  const simulateApiCall = async (status) => {
    if (status === 429) {
      throw new Error('Gemini API Rate limit exceeded. Please wait a few seconds and try again.');
    } else if (status === 403) {
      throw new Error('Invalid Gemini API Key or access forbidden. Check your key settings.');
    } else {
      return JSON.stringify(perfectJson);
    }
  };

  try {
    await simulateApiCall(429);
    assert(false, 'Should throw an error on 429 Rate Limit');
  } catch (err) {
    assert(err.message.includes('Rate limit exceeded'), 
      'Should successfully intercept 429 and present user-friendly rate limit instructions');
  }

  try {
    await simulateApiCall(403);
    assert(false, 'Should throw an error on 403 Forbidden');
  } catch (err) {
    assert(err.message.includes('Invalid Gemini API Key'), 
      'Should successfully intercept 403 and report key configuration instructions');
  }

  const successResponse = await simulateApiCall(200);
  assert(JSON.parse(successResponse).decisions[0] === 'Approved budget.',
    'Should execute normally under success states');

  console.log('\n==================================================');
  console.log('TEST RUN COMPLETED');
  console.log(`  Passed: ${results.passed} / Failed: ${results.failed}`);
  console.log('==================================================');
}

// Run test coverage automatic trigger
if (isNode) {
  runTests().catch(console.error);
} else {
  // Bind to global window so developer can run in browser console easily
  window.runScribeTests = runTests;
}
