#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();

    let body = r#"{"model":"xopdeepseekv4flash","max_tokens":100,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"#;

    let response = client
        .post("http://localhost:3000/v1/messages")
        .header("x-api-key", "sk-UzmYlt1va23Gm8A8bntEuSN0cRJfWyg1RaLoYDZrofCReC4B")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "interleaved-thinking-2025-05-14")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();

    println!("status: {}", response.status());
    
    let text = response.text().await.unwrap();
    println!("body length: {}", text.len());
    println!("first 500: {}", &text[..500.min(text.len())]);
}
