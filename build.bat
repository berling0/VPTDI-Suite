@echo off
go build -trimpath -ldflags "-s -w -H windowsgui" -o "VAG MSA15.5 Suite.exe" .
pause
