# This script can be used to generate PNG files for different sizes
# Requires InkScape to be installed and on your PATH

# Edit this to change the sizes of the PNG files generated
$sizes = 1024, 256, 128, 64, 32


$svgs = Get-ChildItem -Path "svg" -File -Filter *.svg

foreach ($size in $sizes) {
	mkdir -Force -Path "${size}x" | Out-Null

	foreach ($svg in $svgs) {
		$fileName = "${size}x/$($svg.BaseName)_${size}x.png"

		Write-Host "Generating $fileName..." -ForegroundColor Green
		inkscape -w $size -h $size $svg -o $fileName
	}
}
