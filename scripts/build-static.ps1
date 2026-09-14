# Builds public/data/routes.json and public/data/lrt.geojson from the ETS static GTFS extract.
# Usage: download https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip, extract to _data/gtfs/, run this script.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$g = "$root\_data\gtfs"
$out = "$root\public\data"
New-Item -ItemType Directory -Force $out | Out-Null

# ---- routes.json ----
$routes = Import-Csv "$g\routes.txt"
$agencies = @{}
Import-Csv "$g\agency.txt" | ForEach-Object { $agencies[$_.agency_id] = $_.agency_name }
$rmap = [ordered]@{}
foreach ($r in $routes) {
  $color = if ($r.route_color) { $r.route_color } else { '005087' }
  $tcolor = if ($r.route_text_color) { $r.route_text_color } else { 'FFFFFF' }
  $rmap[$r.route_id] = [ordered]@{
    n = $r.route_short_name
    l = $r.route_long_name
    t = [int]$r.route_type
    c = $color
    tc = $tcolor
    a = $agencies[$r.agency_id]
  }
}
($rmap | ConvertTo-Json -Compress -Depth 4) | Out-File "$out\routes.json" -Encoding utf8 -NoNewline
"routes.json: $($rmap.Count) routes, $((Get-Item "$out\routes.json").Length) bytes"

# ---- lrt.geojson ----
$lrtRoutes = @{}
$routes | Where-Object { $_.route_type -eq '0' } | ForEach-Object { $lrtRoutes[$_.route_id] = $_ }
$shapeToRoute = @{}
$reader = [IO.File]::OpenText("$g\trips.txt")
$hdr = $reader.ReadLine().Split(',')
$iRoute = [array]::IndexOf($hdr, 'route_id'); $iShape = [array]::IndexOf($hdr, 'shape_id'); $iDir = [array]::IndexOf($hdr, 'direction_id')
while ($null -ne ($line = $reader.ReadLine())) {
  $c = $line.Split(',')
  if ($lrtRoutes.ContainsKey($c[$iRoute]) -and $c[$iShape]) {
    if (-not $shapeToRoute.ContainsKey($c[$iShape])) { $shapeToRoute[$c[$iShape]] = @{ route = $c[$iRoute]; dir = $c[$iDir] } }
  }
}
$reader.Close()
"LRT shape ids: $($shapeToRoute.Count)"

$pts = @{}
$reader = [IO.File]::OpenText("$g\shapes.txt")
$null = $reader.ReadLine()
while ($null -ne ($line = $reader.ReadLine())) {
  $c = $line.Split(',')
  if ($shapeToRoute.ContainsKey($c[0])) {
    if (-not $pts.ContainsKey($c[0])) { $pts[$c[0]] = New-Object System.Collections.ArrayList }
    $null = $pts[$c[0]].Add(@([double]$c[2], [double]$c[1], [int]$c[3]))
  }
}
$reader.Close()

function PerpDist($p, $a, $b) {
  $dx = $b[0] - $a[0]; $dy = $b[1] - $a[1]
  if ($dx -eq 0 -and $dy -eq 0) { return [math]::Sqrt(($p[0]-$a[0])*($p[0]-$a[0]) + ($p[1]-$a[1])*($p[1]-$a[1])) }
  $t = (($p[0]-$a[0])*$dx + ($p[1]-$a[1])*$dy) / ($dx*$dx + $dy*$dy)
  if ($t -lt 0) { $t = 0 } elseif ($t -gt 1) { $t = 1 }
  $px = $a[0] + $t*$dx; $py = $a[1] + $t*$dy
  return [math]::Sqrt(($p[0]-$px)*($p[0]-$px) + ($p[1]-$py)*($p[1]-$py))
}
function Simplify($points, $tol) {
  # iterative Douglas-Peucker
  $n = $points.Count
  $keep = New-Object bool[] $n
  $keep[0] = $true; $keep[$n-1] = $true
  $stackS = New-Object 'System.Collections.Generic.Stack[int]'
  $stackE = New-Object 'System.Collections.Generic.Stack[int]'
  $stackS.Push(0); $stackE.Push($n-1)
  while ($stackS.Count -gt 0) {
    [int]$s = $stackS.Pop(); [int]$e = $stackE.Pop()
    $maxD = 0.0; $idx = -1
    for ($i = $s+1; $i -lt $e; $i++) {
      $d = PerpDist $points[$i] $points[$s] $points[$e]
      if ($d -gt $maxD) { $maxD = $d; $idx = $i }
    }
    if ($maxD -gt $tol -and $idx -gt 0) { $keep[$idx] = $true; $stackS.Push($s); $stackE.Push($idx); $stackS.Push($idx); $stackE.Push($e) }
  }
  $res = @()
  for ($i = 0; $i -lt $n; $i++) { if ($keep[$i]) { $res += ,@([math]::Round($points[$i][0], 5), [math]::Round($points[$i][1], 5)) } }
  return $res
}

# Keep only the longest shape per route: both directions follow the same alignment.
$longest = @{}
foreach ($sid in $pts.Keys) {
  $route = $shapeToRoute[$sid].route
  if (-not $longest.ContainsKey($route) -or $pts[$sid].Count -gt $pts[$longest[$route]].Count) { $longest[$route] = $sid }
}
$features = @()
foreach ($sid in $longest.Values) {
  $sorted = $pts[$sid] | Sort-Object { $_[2] }
  $simp = Simplify @($sorted) 0.00004
  $meta = $shapeToRoute[$sid]; $r = $lrtRoutes[$meta.route]
  $features += [ordered]@{
    type = 'Feature'
    properties = [ordered]@{ shape = $sid; route = $meta.route; name = $r.route_long_name; color = "#$($r.route_color)"; dir = $meta.dir }
    geometry = [ordered]@{ type = 'LineString'; coordinates = @($simp | ForEach-Object { ,@($_[0], $_[1]) }) }
  }
  "  $sid -> $($sorted.Count) pts -> $($simp.Count) pts"
}
$fc = [ordered]@{ type = 'FeatureCollection'; features = $features }
($fc | ConvertTo-Json -Compress -Depth 6) | Out-File "$out\lrt.geojson" -Encoding utf8 -NoNewline
"lrt.geojson: $($features.Count) features, $((Get-Item "$out\lrt.geojson").Length) bytes"
