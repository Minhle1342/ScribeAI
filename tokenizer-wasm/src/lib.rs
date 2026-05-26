use wasm_bindgen::prelude::*;
use std::ffi::CString;
use std::os::raw::c_char;

#[derive(Debug, Clone)]
struct TokenSpan {
    start: usize,
    end: usize,
    token_count: usize,
}

/// Tokenizes text into high-fidelity spans, calculating token counts for each span.
fn estimate_token_spans(text: &str) -> Vec<TokenSpan> {
    let mut spans = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n == 0 {
        return spans;
    }

    let mut i = 0;
    while i < n {
        let start = i;
        let c = chars[i];

        if c.is_whitespace() {
            if c == '\n' || c == '\r' {
                i += 1;
                spans.push(TokenSpan {
                    start,
                    end: i,
                    token_count: 1,
                });
            } else {
                while i < n && chars[i].is_whitespace() && chars[i] != '\n' && chars[i] != '\r' {
                    i += 1;
                }
                spans.push(TokenSpan {
                    start,
                    end: i,
                    token_count: 1,
                });
            }
        } else if c.is_ascii_punctuation() {
            i += 1;
            spans.push(TokenSpan {
                start,
                end: i,
                token_count: 1,
            });
        } else if c.is_numeric() {
            while i < n && chars[i].is_numeric() {
                i += 1;
            }
            let length = i - start;
            let token_count = (length + 2) / 3; // Standard BPE splits numbers into groups of 2-3 digits
            spans.push(TokenSpan {
                start,
                end: i,
                token_count,
            });
        } else {
            while i < n && !chars[i].is_whitespace() && !chars[i].is_ascii_punctuation() && !chars[i].is_numeric() {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let mut word_tokens = 0;

            let mut ascii_len = 0;
            let mut non_ascii_len = 0;

            for ch in word.chars() {
                if ch.is_ascii() {
                    ascii_len += 1;
                } else {
                    non_ascii_len += 1;
                }
            }

            if ascii_len > 0 {
                word_tokens += (ascii_len + 3) / 4;
            }

            if non_ascii_len > 0 {
                word_tokens += (non_ascii_len * 2 + 1) / 3; // Handles non-ASCII diacritics precisely
            }

            if word_tokens == 0 {
                word_tokens = 1;
            }

            spans.push(TokenSpan {
                start,
                end: i,
                token_count: word_tokens,
            });
        }
    }

    spans
}

/// Dynamic context compress logic.
fn smart_context_compress(
    text: &str,
    target_token_limit: usize,
    lead_token_reserve: usize,
) -> String {
    let spans = estimate_token_spans(text);
    let total_tokens: usize = spans.iter().map(|s| s.token_count).sum();

    if total_tokens <= target_token_limit {
        return text.to_string();
    }

    let truncation_notice = "\n\n... [TRUNCATED - TRANSCRIPT COMPRESSED TO SURVIVE MODEL LIMITS] ...\n\n";
    let truncation_notice_tokens = 15;

    if target_token_limit <= lead_token_reserve + truncation_notice_tokens {
        let mut accumulated_tokens = 0;
        let mut split_char_idx = text.len();
        let chars: Vec<char> = text.chars().collect();

        for span in &spans {
            if accumulated_tokens + span.token_count > lead_token_reserve {
                split_char_idx = span.start;
                break;
            }
            accumulated_tokens += span.token_count;
        }

        let lead_text: String = chars[0..split_char_idx].iter().collect();
        return format!("{}{}", lead_text, truncation_notice);
    }

    let remaining_tokens = target_token_limit - lead_token_reserve - truncation_notice_tokens;

    // 1. Extract Lead Text
    let mut accumulated_tokens = 0;
    let mut lead_split_char_idx = 0;
    for span in &spans {
        if accumulated_tokens + span.token_count > lead_token_reserve {
            lead_split_char_idx = span.start;
            break;
        }
        accumulated_tokens += span.token_count;
    }

    // 2. Extract Tail Text
    let mut accumulated_tail_tokens = 0;
    let mut tail_split_char_idx = text.len();
    for span in spans.iter().rev() {
        if accumulated_tail_tokens + span.token_count > remaining_tokens {
            tail_split_char_idx = span.end;
            break;
        }
        accumulated_tail_tokens += span.token_count;
    }

    let chars: Vec<char> = text.chars().collect();
    let lead_text: String = chars[0..lead_split_char_idx].iter().collect();
    let tail_text: String = chars[tail_split_char_idx..].iter().collect();

    format!("{}{}{}", lead_text, truncation_notice, tail_text)
}

// ==========================================
// C-Style ABI Boundary exports for JS
// ==========================================

#[no_mangle]
pub extern "C" fn count_tokens(text_ptr: *const u8, text_len: usize) -> usize {
    if text_ptr.is_null() || text_len == 0 {
        return 0;
    }
    let text_slice = unsafe { std::slice::from_raw_parts(text_ptr, text_len) };
    let text = std::str::from_utf8(text_slice).unwrap_or("");
    let spans = estimate_token_spans(text);
    spans.iter().map(|s| s.token_count).sum()
}

#[no_mangle]
pub extern "C" fn get_compress_ptr(
    text_ptr: *const u8,
    text_len: usize,
    target_token_limit: usize,
    lead_token_reserve: usize,
) -> *mut c_char {
    let text_slice = if text_ptr.is_null() || text_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(text_ptr, text_len) }
    };
    let text = std::str::from_utf8(text_slice).unwrap_or("");
    let compressed = smart_context_compress(text, target_token_limit, lead_token_reserve);
    let c_str = CString::new(compressed).unwrap();
    c_str.into_raw()
}

#[no_mangle]
pub extern "C" fn free_compress_ptr(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            let _ = CString::from_raw(ptr);
        }
    }
}

// Dynamic allocation helpers for JNI/JS bindings
#[no_mangle]
pub extern "C" fn alloc_memory(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn free_memory(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, size);
        }
    }
}
