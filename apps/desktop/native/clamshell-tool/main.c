#include <IOKit/IOKitLib.h>
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

#define CLAMSHELL_SLEEP_STATE_SELECTOR 12

int main(void) {
    io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"));
    if (!service) {
        fprintf(stderr, "IOPMrootDomain not found\n");
        return 1;
    }

    io_connect_t connection;
    kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &connection);
    IOObjectRelease(service);
    if (result != kIOReturnSuccess) {
        fprintf(stderr, "IOServiceOpen failed: 0x%x\n", result);
        return 1;
    }

    uint64_t value = 1;
    uint32_t outputCount = 0;
    result = IOConnectCallScalarMethod(connection, CLAMSHELL_SLEEP_STATE_SELECTOR, &value, 1, NULL, &outputCount);
    if (result != kIOReturnSuccess) {
        fprintf(stderr, "IOConnectCallScalarMethod failed: 0x%x\n", result);
        IOServiceClose(connection);
        return 2;
    }

    printf("clamshell sleep disabled, holding connection (pid %d)\n", getpid());
    fflush(stdout);
    char buffer[64];
    ssize_t count;
    do {
        count = read(STDIN_FILENO, buffer, sizeof(buffer));
    } while (count > 0 || (count < 0 && errno == EINTR));
    IOServiceClose(connection);
    return 0;
}
