# Enregistre la tâche planifiée Windows pour Lovebox Analytics.
# À lancer UNE FOIS en PowerShell (clic droit > Exécuter avec PowerShell, ou terminal admin).
#
#  - Rapport mensuel : le 3 de chaque mois à 08:00 (collect(M-1) + report complet).
#    Le 3 est choisi pour laisser le temps aux données de se consolider
#    (latence GA4 ~48h, GSC ~3 jours — voir SPEC §1).
#
# Alternatives si le PC n'est pas allumé en continu : la skill /schedule de
# Claude Code, ou un cron GitHub Actions sur ce dépôt.
#
# Pour supprimer : Unregister-ScheduledTask -TaskName "Lovebox Analytics Monthly"

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node -Argument "src\index.js monthly" -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -Monthly -DaysOfMonth 3 -At "08:00"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName "Lovebox Analytics Monthly" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "OK  Lovebox Analytics Monthly  (le 3 de chaque mois a 08:00)"
Write-Host ""
Write-Host "Necessite que le PC soit allume a ce moment-la. Sinon : /schedule de Claude Code, ou GitHub Actions."
