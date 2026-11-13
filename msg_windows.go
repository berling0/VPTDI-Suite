package main

import (
	"syscall"
	"unsafe"
)

// The program is built without a console, so errors are shown in a message box.
func showError(msg string) {
	t, _ := syscall.UTF16PtrFromString("VAG VPTDI")
	m, _ := syscall.UTF16PtrFromString(msg)
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}
