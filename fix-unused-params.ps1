# Fix unused parameter warnings
$fixes = @{
    'src/core/binScoring.ts' = @(
        @{line=261; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=266; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=271; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=276; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=281; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'}
    )
    'src/core/dlmmTelemetry.ts' = @(
        @{line=70; old='poolAddress: string'; new='_poolAddress: string'},
        @{line=75; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'}
    )
    'src/core/killSwitch.ts' = @(
        @{line=17; old='positions: ActivePosition[]'; new='_positions: ActivePosition[]'},
        @{line=234; old='pool: '; new='_pool: '},
        @{line=235; old='telemetry: '; new='_telemetry: '},
        @{line=236; old='binScore: '; new='_binScore: '},
        @{line=242; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=247; old='telemetry: DLMMTelemetry'; new='_telemetry: DLMMTelemetry'},
        @{line=253; old='currentTelemetry'; new='_currentTelemetry'},
        @{line=254; old='historicalTelemetry'; new='_historicalTelemetry'}
    )
    'src/core/mempoolPredation.ts' = @(
        @{line=154; old='poolAddress: string'; new='_poolAddress: string'},
        @{line=155; old='timeWindowMs: number'; new='_timeWindowMs: number'}
    )
    'src/core/structuralEntry.ts' = @(
        @{line=123; old='pool: '; new='_pool: '},
        @{line=124; old='telemetry: '; new='_telemetry: '},
        @{line=125; old='binScore: '; new='_binScore: '}
    )
}

foreach ($file in $fixes.Keys) {
    $content = Get-Content $file
    foreach ($fix in $fixes[$file]) {
        $content[$fix.line - 1] = $content[$fix.line - 1] -replace [regex]::Escape($fix.old), $fix.new
    }
    $content | Set-Content $file
}

Write-Host "Fixed unused parameters"
