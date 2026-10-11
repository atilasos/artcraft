//! NRS build: the hosts this app may fetch from outside the browser's CORS
//! rules. Upstream's `load_without_cors_command` fetched any URL (its own TODO
//! asked for an allowlist), and the HTTP plugin scope allowed `https://*`.
//! Both now use this list. Add a provider's domain here when a new one is
//! wired in; a refused URL fails with a plain message instead of being fetched.

use url::Url;

/// Registrable domains. A URL is allowed when its host is one of these or a
/// subdomain of one, and its scheme is https.
pub const NRS_ALLOWED_DOMAINS: &[&str] = &[
  "storyteller.ai",
  "fakeyou.com",
  "getartcraft.com",
  "artcraft.ai",
  "r2.dev",
  "googleapis.com",
  "googleusercontent.com",
  "gravatar.com",
  "fal.ai",
  "fal.media",
  "fal.run",
  "x.ai",
  "grok.com",
  "twimg.com",
  "worldlabs.ai",
  "wlt-ai.art",
  "chatgpt.com",
  "openai.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "sora.com",
  "midjourney.com",
  "kinovi.ai",
  "seedance2-pro.com",
  "gmicloud.ai",
  "notrealsmart.com.au",
];

pub fn is_allowed_url(url: &str) -> bool {
  let Ok(parsed) = Url::parse(url) else { return false };
  if parsed.scheme() != "https" {
    return false;
  }
  let Some(host) = parsed.host_str() else { return false };
  let host = host.to_ascii_lowercase();
  NRS_ALLOWED_DOMAINS.iter().any(|domain| {
    host == *domain || host.ends_with(&format!(".{}", domain))
  })
}

#[cfg(test)]
mod tests {
  use super::is_allowed_url;

  #[test]
  fn allows_listed_domain_and_subdomains() {
    assert!(is_allowed_url("https://cdn-2.fakeyou.com/media/a.png"));
    assert!(is_allowed_url("https://api.storyteller.ai/v1/x"));
    assert!(is_allowed_url("https://pub-abc.r2.dev/media/a.jpg"));
    assert!(is_allowed_url("https://www.notrealsmart.com.au/api/nrs/mcp"));
  }

  #[test]
  fn refuses_other_hosts_schemes_and_lookalikes() {
    assert!(!is_allowed_url("https://example.com/a.png"));
    assert!(!is_allowed_url("http://cdn-2.fakeyou.com/a.png"));
    assert!(!is_allowed_url("https://fakeyou.com.evil.example/a.png"));
    assert!(!is_allowed_url("https://evilfakeyou.com/a.png"));
    assert!(!is_allowed_url("file:///etc/passwd"));
    assert!(!is_allowed_url("https://127.0.0.1/a.png"));
    assert!(!is_allowed_url("not a url"));
  }
}
