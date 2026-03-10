$env:SUPABASE_ACCESS_TOKEN = "sbp_22407d9265d574d725aa6993472bcc87550e5fb8"
$functions = @("task-complete", "telegram-notify", "telegram-webhook", "session-end", "daily-briefing")
foreach ($fn in $functions) {
    Write-Host "Deploying $fn..."
    npx supabase functions deploy $fn --project-ref ujgbhkllfeacbgpdbjto --no-verify-jwt
}
Write-Host "全Edge Functions デプロイ完了"
