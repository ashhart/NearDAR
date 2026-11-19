#ifndef TENSORFOLD_MOBILE_H
#define TENSORFOLD_MOBILE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void *SonarTensorFoldEngine;

typedef enum SonarTensorFoldEventKind {
  SONAR_TENSORFOLD_TOKENS = 1,
  SONAR_TENSORFOLD_FINISHED = 2,
} SonarTensorFoldEventKind;

typedef enum SonarTensorFoldFinishReason {
  SONAR_TENSORFOLD_STOP = 0,
  SONAR_TENSORFOLD_LENGTH = 1,
  SONAR_TENSORFOLD_CANCELLED = 2,
  SONAR_TENSORFOLD_FAILED = 3,
} SonarTensorFoldFinishReason;

typedef void (*SonarTensorFoldEventCallback)(
    void *context,
    uint64_t request_id,
    SonarTensorFoldEventKind kind,
    const uint32_t *token_ids,
    size_t token_count,
    const char *text,
    size_t text_length,
    SonarTensorFoldFinishReason finish_reason,
    const char *message);

/* The returned UTF-8 JSON is static and must not be freed. */
const char *sonar_tf_capabilities_json(void);

/*
 * Opens exactly one real model. The context and cache limits are hard startup
 * limits. `error` receives a NUL-terminated diagnostic on failure.
 */
SonarTensorFoldEngine sonar_tf_open(
    const char *checkpoint_directory,
    uint32_t max_context_tokens,
    uint32_t prompt_cache_mib,
    char *error,
    size_t error_capacity);

/* Valid until close. The returned UTF-8 JSON must not be freed. */
const char *sonar_tf_info_json(SonarTensorFoldEngine engine);

/* Stops the engine thread and finishes outstanding requests before returning. */
void sonar_tf_close(SonarTensorFoldEngine engine);

/*
 * Queues raw-prompt generation. Text and token ids are streamed through the
 * callback on the engine thread. The callback must not call back into TensorFold.
 * Returns zero on acceptance and writes a diagnostic on refusal.
 */
int32_t sonar_tf_generate(
    SonarTensorFoldEngine engine,
    uint64_t request_id,
    const char *prompt,
    size_t prompt_length,
    uint32_t max_tokens,
    int32_t sample,
    double temperature,
    uint32_t top_k,
    double top_p,
    double min_p,
    uint64_t seed,
    SonarTensorFoldEventCallback callback,
    void *callback_context,
    char *error,
    size_t error_capacity);

void sonar_tf_cancel(SonarTensorFoldEngine engine, uint64_t request_id);

#ifdef __cplusplus
}
#endif

#endif
