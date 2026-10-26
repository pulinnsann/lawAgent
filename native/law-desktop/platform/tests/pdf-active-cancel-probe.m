// This synthetic lifecycle probe is built with -DLAW_PDF_PROBE. It never
// accesses the keychain or an actual customer document.
#import <Cocoa/Cocoa.h>
#import <PDFKit/PDFKit.h>
extern void law_pdf_start(const char *, const char *, void (*)(void *, const char *), void *, uint64_t);
extern void law_pdf_cancel(uint64_t);
extern bool law_pdf_is_printing(uint64_t);
extern uint64_t law_pdf_printing_count(void);
extern void law_pdf_cancel_all(void (*)(void *), void *);
static NSString *outputPath;
static unsigned int cancelledCount;
static CFAbsoluteTime cancelledAt;
static void cancelled(void *context, const char *error) {
    if (!error || ++cancelledCount != 1) { fprintf(stderr, "Active PDF cancellation callback failed\n"); exit(1); }
}
static void completed(void *context, const char *error) {
    if (error) { fprintf(stderr, "%s\n", error); exit(1); }
    PDFDocument *pdf = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:outputPath]];
    if (cancelledCount != 1 || pdf.pageCount != 1 || ![pdf.string containsString:@"Export after cancellation"]
        || law_pdf_printing_count() != 0) {
        fprintf(stderr, "PDF native cleanup/reuse failed\n"); exit(1);
    }
    fprintf(stdout, "{\"cancelledWhilePrinting\":true,\"cancelledCallbacks\":1,\"remainingPrintOperations\":0,\"followupPages\":1}\n");
    fflush(stdout); exit(0);
}
static void allStopped(void *context) {
    if (law_pdf_printing_count() != 0) { fprintf(stderr, "Native print completion barrier returned early\n"); exit(1); }
    fprintf(stderr, "Native print stopped %.3f seconds after cancellation\n", CFAbsoluteTimeGetCurrent() - cancelledAt);
    law_pdf_start("<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\"><h1>Export after cancellation</h1>", outputPath.UTF8String, completed, NULL, 22);
}
static void waitUntilPrinting(void) {
    if (law_pdf_is_printing(21)) {
        cancelledAt = CFAbsoluteTimeGetCurrent();
        law_pdf_cancel(21);
        law_pdf_cancel(21);
        law_pdf_cancel_all(allStopped, NULL);
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ waitUntilPrinting(); });
}
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 2) { fprintf(stderr, "Usage: pdf-active-cancel-probe /private/synthetic-output.pdf\n"); return 2; }
        outputPath = [NSString stringWithUTF8String:argv[1]];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSMutableString *html = [@"<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>@page{size:A4}body{font:14px Arial}</style>" mutableCopy];
        for (unsigned int index = 0; index < 8000; index++) [html appendFormat:@"<p>Paragraph %u. Synthetic payment, delivery and acceptance terms for active native print cancellation.</p>", index];
        dispatch_async(dispatch_get_main_queue(), ^{
            law_pdf_start(html.UTF8String, [outputPath stringByAppendingString:@".cancelled.pdf"].UTF8String, cancelled, NULL, 21);
            waitUntilPrinting();
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            law_pdf_cancel(21); law_pdf_cancel(22);
            fprintf(stderr, "Active PDF cleanup timed out\n"); exit(1);
        });
        [NSApp run]; return 1;
    }
}
