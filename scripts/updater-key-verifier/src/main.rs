use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

#[cfg(test)]
fn verify_signature(public_key: &str, payload: &[u8], signature: &str) -> Result<(), String> {
    let public_key = PublicKey::from_base64(public_key).map_err(|error| error.to_string())?;
    let signature = Signature::decode(signature).map_err(|error| error.to_string())?;
    public_key
        .verify(payload, &signature, false)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::verify_signature;
    use base64::{engine::general_purpose::STANDARD, Engine};

    const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1633700835\tfile:test\tprehashed\n\
wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    #[test]
    fn accepts_a_signature_from_the_matching_public_key() {
        verify_signature(PUBLIC_KEY, b"test", SIGNATURE).unwrap();
    }

    #[test]
    fn rejects_a_signature_from_a_different_public_key() {
        let other_key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO2";
        assert!(verify_signature(other_key, b"test", SIGNATURE).is_err());
    }

    #[test]
    fn accepts_tauri_base64_wrapped_signature() {
        let encoded = STANDARD.encode(SIGNATURE);
        let decoded = STANDARD.decode(encoded).unwrap();
        let signature_text = std::str::from_utf8(&decoded).unwrap();
        verify_signature(PUBLIC_KEY, b"test", signature_text).unwrap();
    }

    #[test]
    fn rejects_malformed_outer_signature_encoding() {
        assert!(STANDARD.decode("not a signature").is_err());
    }
}

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let Some(public_key_path) = arguments.next() else {
        eprintln!("usage: pipline-updater-key-verifier <public-key> <payload> <signature>");
        std::process::exit(2);
    };
    let Some(payload_path) = arguments.next() else {
        eprintln!("usage: pipline-updater-key-verifier <public-key> <payload> <signature>");
        std::process::exit(2);
    };
    let Some(signature_path) = arguments.next() else {
        eprintln!("usage: pipline-updater-key-verifier <public-key> <payload> <signature>");
        std::process::exit(2);
    };

    let result = (|| {
        let public_key = PublicKey::from_file(public_key_path)
            .map_err(|error| format!("Invalid updater public key: {error}"))?;
        let payload = std::fs::read(payload_path).map_err(|error| error.to_string())?;
        let encoded_signature = std::fs::read_to_string(signature_path)
            .map_err(|error| format!("Could not read updater signature: {error}"))?;
        let signature_text = STANDARD
            .decode(encoded_signature.trim())
            .map_err(|error| format!("Invalid Tauri updater signature encoding: {error}"))?;
        let signature_text = std::str::from_utf8(&signature_text)
            .map_err(|error| format!("Updater signature is not UTF-8: {error}"))?;
        let signature = Signature::decode(signature_text)
            .map_err(|error| format!("Invalid minisign signature: {error}"))?;
        public_key
            .verify(&payload, &signature, false)
            .map_err(|error| format!("Updater signature verification failed: {error}"))
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
