# Reads one fixed SELECT batch from the local Node bridge over stdin.
# No SQL settings, accounts, permissions or objects are modified.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$connection = $null
$command = $null
$reader = $null
$stage = 'input'
try {
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.Data
    # Shared memory forces a LOCAL SQL connection; no SQL TCP listener needed.
    # Windows PowerShell treats SqlConnectionStringBuilder as a dictionary;
    # .DataSource assignment becomes the invalid keyword "DataSource".
    # Construct SqlConnection from canonical connection-string keywords instead.
    $connectionString = 'Data Source=lpc:.\SQLEXPRESS;Initial Catalog=BogamDB;Integrated Security=True;Connect Timeout=3;Pooling=False;Application Name=InhouseBogamSelectBridge'
    $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
    $stage = 'connection'
    $connection.Open()
    $stage = 'parameters'
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
    $stage = 'query'
    $reader = $command.ExecuteReader()
    $stage = 'result_read'
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
    $stage = 'result_serialize'
    [Console]::Out.Write((ConvertTo-Json -InputObject @{ ok=$true; sets=@($sets.ToArray()) } -Depth 10 -Compress))
} catch {
    # Never print SQL exceptions: they can contain values and connection details.
    if ($command) { try { $command.Cancel() } catch {} }
    $code = 'SOURCE_REJECTED'
    $cause = $_.Exception
    $diagnostic = @{ stage=$stage; scriptLine=[int]$_.InvocationInfo.ScriptLineNumber }
    while ($cause) {
        $diagnostic.exceptionType = $cause.GetType().Name
        if ($cause -is [System.Data.SqlClient.SqlException]) {
            $diagnostic.sqlNumber = [int]$cause.Number
            if ($cause.Errors.Count -gt 0) { $diagnostic.sqlLine = [int]$cause.Errors[0].LineNumber }
        }
        if ($cause -is [System.Data.SqlClient.SqlException] -and $cause.Number -eq -2) { $code = 'SYNC_TIMEOUT' }
        $cause = $cause.InnerException
    }
    [Console]::Out.Write((ConvertTo-Json -Compress @{ ok=$false; code=$code; diagnostic=$diagnostic }))
    exit 1
} finally {
    if ($reader) { $reader.Dispose() }
    if ($command) { $command.Dispose() }
    if ($connection) { $connection.Dispose() }
}
