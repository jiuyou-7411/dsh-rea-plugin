set confirm off
set pagination off
set auto-solib-add off
set sysroot
target remote 127.0.0.1:5039
echo --- Register Dump (aarch64) ---\n
info registers x0 x1 x2 x3 x4 x5 x29 x30 sp pc
echo \n--- Read 64 bytes from PC ---\n
x/8gx $pc
echo \n--- Thread List ---\n
info threads
echo \n--- Resume under trace: anti-debug watch window ---\n
continue
echo \n--- continue returned (interrupted or terminated) ---\n
detach
quit
