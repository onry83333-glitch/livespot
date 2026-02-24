Import-Csv "C:\dev\livespot\scripts\dm_unsent_users.csv" |
  Where-Object { $_.heat_level -in @('Hot','Warm','AtRisk') } |
  Select-Object -ExpandProperty user_name |
  Set-Content "C:\dev\livespot\scripts\dm_target_hot_warm_atrisk.txt" -Encoding UTF8

$count1 = (Get-Content "C:\dev\livespot\scripts\dm_target_hot_warm_atrisk.txt").Count
Write-Host "Hot+Warm+AtRisk: $count1 名"

Import-Csv "C:\dev\livespot\scripts\dm_dormant_target.csv" |
  Select-Object -ExpandProperty user_name |
  Set-Content "C:\dev\livespot\scripts\dm_target_dormant_test.txt" -Encoding UTF8

$count2 = (Get-Content "C:\dev\livespot\scripts\dm_target_dormant_test.txt").Count
Write-Host "Dormant: $count2 名"
