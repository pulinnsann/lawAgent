#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>

// This key belongs to the native vault. Electron's Safe Storage item and all
// existing encrypted files remain untouched.
static NSString *LAWVaultService(void) {
#ifdef LAW_DESKTOP_SMOKE
    const char *identifier = getenv("LAW_AGENT_SMOKE_VAULT_ID");
    if (!identifier || strlen(identifier) != 36) return nil;
    NSString *value = [NSString stringWithUTF8String:identifier];
    NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:value];
    if (!uuid) return nil;
    return [@"com.lawagent.desktop.tauri.smoke." stringByAppendingString:uuid.UUIDString.lowercaseString];
#else
    return @"com.lawagent.desktop.tauri";
#endif
}

int32_t law_vault_key(uint8_t *output, bool create) {
    @autoreleasepool {
        NSString *service = LAWVaultService();
        if (!service) return errSecParam;
        LAContext *authentication = [LAContext new];
        authentication.interactionNotAllowed = YES;
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service,
            (__bridge id)kSecAttrAccount: @"credential-encryption-v1",
            (__bridge id)kSecReturnData: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
            (__bridge id)kSecUseAuthenticationContext: authentication
        };
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
        if (status == errSecSuccess) {
            NSData *data = CFBridgingRelease(result);
            if (data.length != 32) return errSecDecode;
            memcpy(output, data.bytes, 32);
            return errSecSuccess;
        }
        if (status != errSecItemNotFound || !create) return status;
        uint8_t key[32];
        status = SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key);
        if (status != errSecSuccess) return status;
        NSDictionary *item = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service,
            (__bridge id)kSecAttrAccount: @"credential-encryption-v1",
            (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            (__bridge id)kSecValueData: [NSData dataWithBytes:key length:32],
            (__bridge id)kSecUseAuthenticationContext: authentication
        };
        status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
        if (status == errSecSuccess) memcpy(output, key, 32);
        volatile uint8_t *wipe = key;
        for (size_t index = 0; index < sizeof(key); index++) wipe[index] = 0;
        // Two simultaneous first writes must agree on the key that won.
        if (status == errSecDuplicateItem) return law_vault_key(output, false);
        return status;
    }
}

#ifdef LAW_DESKTOP_SMOKE
int32_t law_vault_cleanup_test_key(void) {
    @autoreleasepool {
        NSString *service = LAWVaultService();
        if (!service) return errSecParam;
        OSStatus status = SecItemDelete((__bridge CFDictionaryRef)@{
            (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: service,
            (__bridge id)kSecAttrAccount: @"credential-encryption-v1"
        });
        return status == errSecItemNotFound ? errSecSuccess : status;
    }
}
#endif

typedef void (*LAWPDFCallback)(void *context, const char *error);
typedef void (*LAWPDFCleanupCallback)(void *context);
@interface LAWPDFJob : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSPrintOperation *operation;
@property(nonatomic, strong) NSString *path;
@property(nonatomic) void *context;
@property(nonatomic) uint64_t token;
@property(nonatomic) LAWPDFCallback callback;
@property(nonatomic) BOOL finished;
@property(nonatomic, strong) NSMutableArray *cleanupObservers;
- (void)finish:(NSString *)error;
- (void)printOperationDidRun:(NSPrintOperation *)operation success:(BOOL)success contextInfo:(void *)context;
@end

static NSMutableDictionary<NSNumber *, LAWPDFJob *> *LAWPDFJobs;
#ifdef LAW_PDF_PROBE
static uint64_t LAWPDFPrintingCount;
#endif

@implementation LAWPDFJob
- (void)printOperationDidRun:(NSPrintOperation *)operation success:(BOOL)success contextInfo:(void *)context {
    // AppKit does not retain the delegate. Keep it alive until this callback,
    // including after a timeout has removed the job from the active registry.
    LAWPDFJob *retainedJob = CFBridgingRelease(context);
    // NSPrintOperation can complete on its printing thread. Every WKWebView
    // and NSWindow mutation, including their final release, stays on main.
    dispatch_async(dispatch_get_main_queue(), ^{
        #ifdef LAW_PDF_PROBE
        LAWPDFPrintingCount--;
        #endif
        retainedJob.operation = nil;
        [retainedJob finish:success ? nil : @"Native PDF print operation failed"];
    });
}
- (void)finish:(NSString *)error {
    if (!self.finished) {
        self.finished = YES;
        [self.webView stopLoading];
        self.webView.navigationDelegate = nil;
        [self.webView removeFromSuperview];
        self.webView = nil;
        [self.window close];
        self.window = nil;
        LAWPDFCallback callback = self.callback;
        void *context = self.context;
        // Clear before invoking Rust: its future can immediately begin app
        // shutdown, which is allowed to cancel the same job again.
        self.callback = NULL;
        self.context = NULL;
        callback(context, error ? error.UTF8String : NULL);
    }
    if (!self.operation) {
        // AppKit's background print can outlive WKWebView cancellation. Keep
        // the registry entry until its delegate completes on the main thread,
        // so app shutdown can await native completion even if Rust was aborted.
        NSArray *observers = [self.cleanupObservers copy];
        [self.cleanupObservers removeAllObjects];
        [LAWPDFJobs removeObjectForKey:@(self.token)];
        for (void (^observer)(void) in observers) observer();
    }
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSString *scheme = action.request.URL.scheme.lowercaseString;
    BOOL allowed = [scheme isEqualToString:@"about"] || [scheme isEqualToString:@"data"];
    decisionHandler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self finish:@"Native PDF document navigation failed"];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self finish:@"Native PDF document loading failed"];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self finish:@"Native PDF renderer terminated"];
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // WebKit has finished loading inline styles and system-font fallback here.
    // NSPrintOperation uses paginated print layout, unlike createPDF's single
    // continuous canvas, and preserves CSS break-before/inside declarations.
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.finished) return;
        @try {
            NSPrintInfo *info = [[NSPrintInfo sharedPrintInfo] copy];
            info.paperSize = NSMakeSize(595.2756, 841.8898);
            info.orientation = NSPaperOrientationPortrait;
            info.leftMargin = 36;
            info.rightMargin = 36;
            info.topMargin = 36;
            info.bottomMargin = 36;
            info.horizontalPagination = NSPrintingPaginationModeFit;
            info.verticalPagination = NSPrintingPaginationModeAutomatic;
            info.horizontallyCentered = NO;
            info.verticallyCentered = NO;
            info.jobDisposition = NSPrintSaveJob;
            [info.dictionary setObject:@YES forKey:NSPrintAllPages];
            [info.dictionary setObject:[NSURL fileURLWithPath:self.path] forKey:NSPrintJobSavingURL];
            self.operation = [webView printOperationWithPrintInfo:info];
            self.operation.showsPrintPanel = NO;
            self.operation.showsProgressPanel = NO;
            self.operation.canSpawnSeparateThread = YES;
            #ifdef LAW_PDF_PROBE
            LAWPDFPrintingCount++;
            #endif
            [self.operation runOperationModalForWindow:self.window delegate:self
                didRunSelector:@selector(printOperationDidRun:success:contextInfo:)
                contextInfo:(__bridge_retained void *)self];
        } @catch (NSException *exception) {
            [self finish:@"Native PDF print operation failed"];
        }
    });
}
@end

// Both entry points run on the application's main thread. The job dictionary
// retains delegates only until success, failure, or explicit timeout cleanup.
void law_pdf_start(const char *html, const char *path, LAWPDFCallback callback, void *context, uint64_t token) {
    @autoreleasepool {
        if (!LAWPDFJobs) LAWPDFJobs = [NSMutableDictionary dictionary];
        LAWPDFJob *job = [LAWPDFJob new];
        job.context = context;
        job.token = token;
        job.callback = callback;
        job.cleanupObservers = [NSMutableArray array];
        job.path = [NSString stringWithUTF8String:path];
        LAWPDFJobs[@(token)] = job;
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
        configuration.defaultWebpagePreferences.allowsContentJavaScript = NO;
        configuration.suppressesIncrementalRendering = YES;
        job.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 794, 1123) configuration:configuration];
        job.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-10000, -10000, 794, 1123)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        job.window.releasedWhenClosed = NO;
        job.window.contentView = job.webView;
        [job.window orderOut:nil];
        job.webView.navigationDelegate = job;
        [job.webView loadHTMLString:[NSString stringWithUTF8String:html] baseURL:nil];
    }
}

void law_pdf_cancel(uint64_t token) {
    LAWPDFJob *job = LAWPDFJobs[@(token)];
    if (job) [job finish:@"Native PDF rendering timed out"];
}

void law_pdf_cancel_all(LAWPDFCleanupCallback callback, void *context) {
    NSArray<LAWPDFJob *> *jobs = [LAWPDFJobs.allValues copy];
    if (!jobs.count) { callback(context); return; }
    __block NSUInteger remaining = jobs.count;
    for (LAWPDFJob *job in jobs) {
        [job.cleanupObservers addObject:[^{
            if (--remaining == 0) callback(context);
        } copy]];
        [job finish:@"Native PDF export cancelled because the application is closing"];
    }
}

#ifdef LAW_PDF_PROBE
bool law_pdf_is_printing(uint64_t token) {
    LAWPDFJob *job = LAWPDFJobs[@(token)];
    return job && job.operation && !job.finished;
}
uint64_t law_pdf_printing_count(void) { return LAWPDFPrintingCount; }
#endif
