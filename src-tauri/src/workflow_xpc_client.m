#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <Security/Security.h>
#import <Security/SecStaticCode.h>
#import <Security/SecTask.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

uint8_t pipline_workflow_worker_has_sandbox_entitlement(void) {
    @autoreleasepool {
        SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
        if (task == NULL) return 0;
        CFErrorRef error = NULL;
        CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.security.app-sandbox"), &error);
        uint8_t enabled = value != NULL && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
        if (value != NULL) CFRelease(value);
        if (error != NULL) CFRelease(error);
        CFRelease(task);
        return enabled;
    }
}

uint8_t pipline_workflow_code_is_sandboxed_at_path(const char *path, uint8_t is_bundle) {
    @autoreleasepool {
        if (path == NULL) return 0;
        CFURLRef url = CFURLCreateFromFileSystemRepresentation(
            kCFAllocatorDefault, (const UInt8 *)path, (CFIndex)strlen(path), is_bundle != 0);
        if (url == NULL) return 0;

        SecStaticCodeRef code = NULL;
        OSStatus status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
        CFRelease(url);
        if (status != errSecSuccess || code == NULL) return 0;

        status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL);
        CFDictionaryRef information = NULL;
        if (status == errSecSuccess) {
            status = SecStaticCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
        }
        CFRelease(code);
        if (status != errSecSuccess || information == NULL) {
            if (information != NULL) CFRelease(information);
            return 0;
        }

        CFDictionaryRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
        CFTypeRef sandbox = entitlements == NULL
            ? NULL
            : CFDictionaryGetValue(entitlements, CFSTR("com.apple.security.app-sandbox"));
        uint8_t enabled = sandbox != NULL
            && CFGetTypeID(sandbox) == CFBooleanGetTypeID()
            && CFBooleanGetValue((CFBooleanRef)sandbox);
        CFRelease(information);
        return enabled;
    }
}

@protocol PiplineWorkflowRunnerProtocol
- (void)executeRequestID:(NSString *)requestID
                 request:(NSData *)request
               withReply:(void (^)(NSData * _Nullable response, NSString * _Nullable error))reply;
- (void)cancelRequestID:(NSString *)requestID withReply:(void (^)(BOOL accepted))reply;
@end

static void write_error(char *destination, size_t capacity, NSString *message) {
    if (destination == NULL || capacity == 0) return;
    NSData *utf8 = [message dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:YES];
    size_t count = MIN(capacity - 1, utf8.length);
    if (count > 0) memcpy(destination, utf8.bytes, count);
    destination[count] = '\0';
}

int pipline_workflow_xpc_execute(const char *request_id,
                                 const uint8_t *request_bytes,
                                 size_t request_length,
                                 uint8_t *response_bytes,
                                 size_t response_capacity,
                                 size_t *response_length,
                                 char *error_buffer,
                                 size_t error_capacity) {
    @autoreleasepool {
        if (request_id == NULL || request_bytes == NULL || response_bytes == NULL || response_length == NULL) {
            write_error(error_buffer, error_capacity, @"Invalid XPC request buffer");
            return 1;
        }

        NSString *identifier = [NSString stringWithUTF8String:request_id];
        if (identifier == nil || [[NSUUID alloc] initWithUUIDString:identifier] == nil) {
            write_error(error_buffer, error_capacity, @"Invalid XPC request identifier");
            return 1;
        }

        NSXPCConnection *connection = [[NSXPCConnection alloc] initWithServiceName:@"app.pipline.desktop.workflow-runner"];
        connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(PiplineWorkflowRunnerProtocol)];
        [connection resume];

        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block NSData *received = nil;
        __block NSString *remoteError = nil;
        __block BOOL gotReply = NO;
        id<PiplineWorkflowRunnerProtocol> proxy = (id<PiplineWorkflowRunnerProtocol>)[connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
            remoteError = error.localizedDescription ?: @"XPC connection failed";
            dispatch_semaphore_signal(completed);
        }];
        NSData *request = [NSData dataWithBytes:request_bytes length:request_length];
        [proxy executeRequestID:identifier request:request withReply:^(NSData *response, NSString *error) {
            received = response;
            remoteError = error;
            gotReply = YES;
            dispatch_semaphore_signal(completed);
        }];

        long wait_result = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
        [connection invalidate];
        if (wait_result != 0) {
            write_error(error_buffer, error_capacity, @"Timed out waiting for the XPC workflow runner");
            return 2;
        }
        if (!gotReply || remoteError != nil || received == nil) {
            write_error(error_buffer, error_capacity, remoteError ?: @"XPC workflow runner returned no data");
            return 3;
        }
        if (received.length > response_capacity) {
            write_error(error_buffer, error_capacity, @"XPC workflow response exceeds the caller buffer");
            return 4;
        }
        memcpy(response_bytes, received.bytes, received.length);
        *response_length = received.length;
        return 0;
    }
}

int pipline_workflow_xpc_cancel(const char *request_id) {
    @autoreleasepool {
        if (request_id == NULL) return 1;
        NSString *identifier = [NSString stringWithUTF8String:request_id];
        if (identifier == nil || [[NSUUID alloc] initWithUUIDString:identifier] == nil) return 1;

        NSXPCConnection *connection = [[NSXPCConnection alloc] initWithServiceName:@"app.pipline.desktop.workflow-runner"];
        connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(PiplineWorkflowRunnerProtocol)];
        [connection resume];

        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block BOOL accepted = NO;
        id<PiplineWorkflowRunnerProtocol> proxy = (id<PiplineWorkflowRunnerProtocol>)[connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
            dispatch_semaphore_signal(completed);
        }];
        [proxy cancelRequestID:identifier withReply:^(BOOL didAccept) {
            accepted = didAccept;
            dispatch_semaphore_signal(completed);
        }];
        long wait_result = dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        [connection invalidate];
        return wait_result == 0 && accepted ? 0 : 2;
    }
}
