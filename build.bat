@echo off
go build -trimpath -ldflags "-s -w -H windowsgui" -o "VAG VPTDI.exe" .
pause
