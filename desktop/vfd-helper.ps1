$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$vfdPort = $null
$vfdKey = ''
try {
  while ($null -ne ($vfdInput = [Console]::ReadLine())) {
    $vfdRequest = $null
    try {
      $vfdRequest = $vfdInput | ConvertFrom-Json
      $vfdResult = @{}
      switch ($vfdRequest.action) {
        'ports' { $vfdResult.ports = @([System.IO.Ports.SerialPort]::GetPortNames()) }
        'close' { if ($null -ne $vfdPort) { $vfdPort.Dispose(); $vfdPort = $null }; $vfdKey = '' }
        'write' {
          $vfdConfig = $vfdRequest.config
          if ($vfdConfig.port -notmatch '^COM[1-9]\d{0,2}$') { throw 'Port COM invalide.' }
          $vfdConfigKey = $vfdConfig | ConvertTo-Json -Compress
          if ($vfdConfigKey -ne $vfdKey -or $null -eq $vfdPort -or -not $vfdPort.IsOpen) {
            if ($null -ne $vfdPort) { $vfdPort.Dispose(); $vfdPort = $null }
            $vfdPort = New-Object System.IO.Ports.SerialPort
            $vfdPort.PortName = $vfdConfig.port
            $vfdPort.BaudRate = [int]$vfdConfig.baudRate
            $vfdPort.DataBits = [int]$vfdConfig.dataBits
            $vfdPort.Parity = [System.Enum]::Parse([System.IO.Ports.Parity], $vfdConfig.parity)
            $vfdPort.StopBits = [System.Enum]::Parse([System.IO.Ports.StopBits], $vfdConfig.stopBits)
            $vfdPort.Handshake = [System.Enum]::Parse([System.IO.Ports.Handshake], $vfdConfig.handshake)
            $vfdPort.DtrEnable = [bool]$vfdConfig.dtrEnable
            $vfdPort.RtsEnable = [bool]$vfdConfig.rtsEnable
            $vfdPort.WriteTimeout = 1500
            $vfdPort.Open()
            $vfdKey = $vfdConfigKey
          }
          $vfdBytes = [Convert]::FromBase64String($vfdRequest.bytes)
          $vfdPort.Write($vfdBytes, 0, $vfdBytes.Length)
        }
        default { throw 'Commande VFD inconnue.' }
      }
      $vfdResult.id = $vfdRequest.id
      $vfdResult.ok = $true
      [Console]::WriteLine(($vfdResult | ConvertTo-Json -Compress))
    } catch {
      if ($null -ne $vfdPort) { $vfdPort.Dispose(); $vfdPort = $null }; $vfdKey = ''
      [Console]::WriteLine((@{id=$vfdRequest.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress))
    }
  }
} finally { if ($null -ne $vfdPort) { $vfdPort.Dispose() } }
