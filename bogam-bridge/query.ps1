# Reads one fixed SELECT batch from the local Node bridge over stdin.
# No SQL settings, accounts, permissions or objects are modified.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$connection = $null
$command = $null
$reader = $null
try {
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.Data
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    # Shared memory forces a LOCAL SQL connection; no SQL TCP listener needed.
    $builder.DataSource = 'lpc:.\SQLEXPRESS'
    $builder.InitialCatalog = 'BogamDB'
    $builder.IntegratedSecurity = $true
    $builder.ConnectTimeout = 3
    $builder.Pooling = $false
    $builder.ApplicationName = 'InhouseBogamSelectBridge'
    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 5
    $command.CommandText = $inputData.sql
    foreach ($property in $inputData.parameters.PSObject.Properties) {
        $item = $property.Value
        $sqlType = [System.Enum]::Parse([System.Data.SqlDbType], [string]$item.type)
        $param = $command.Parameters.Add('@' + $property.Name, $sqlType)
        if ($item.type -eq 'DateTime') {
            $param.Value = [DateTime]::ParseExact($item.value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        } else { $param.Size = 8; $param.Value = [string]$item.value }
    }
    $reader = $command.ExecuteReader()
    $sets = New-Object 'System.Collections.Generic.List[object]'
    do {
        $rows = New-Object 'System.Collections.Generic.List[object]'
        while ($reader.Read()) {
            if ($rows.Count -ge 10001) { throw 'ROW_LIMIT' }
            $row = [ordered]@{}
            for ($column = 0; $column -lt $reader.FieldCount; $column++) {
                $value = $reader.GetValue($column)
                if ($value -is [DBNull]) { $value = $null }
                $row[$reader.GetName($column)] = $value
            }
            $rows.Add([pscustomobject]$row)
        }
        $sets.Add(@($rows.ToArray()))
    } while ($reader.NextResult())
    [Console]::Out.Write((ConvertTo-Json -InputObject @{ ok=$true; sets=@($sets.ToArray()) } -Depth 10 -Compress))
} catch {
    # Never print SQL exceptions: they can contain values and connection details.
    if ($command) { try { $command.Cancel() } catch {} }
    $code = 'SOURCE_REJECTED'
    $cause = $_.Exception
    while ($cause) {
        if ($cause -is [System.Data.SqlClient.SqlException] -and $cause.Number -eq -2) { $code = 'SYNC_TIMEOUT' }
        $cause = $cause.InnerException
    }
    [Console]::Out.Write((ConvertTo-Json -Compress @{ ok=$false; code=$code }))
    exit 1
} finally {
    if ($reader) { $reader.Dispose() }
    if ($command) { $command.Dispose() }
    if ($connection) { $connection.Dispose() }
}
