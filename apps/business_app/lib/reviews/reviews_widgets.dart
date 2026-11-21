import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'reviews_models.dart';

class Stars extends StatelessWidget {
  const Stars({super.key, required this.rating, this.size = 16});
  final double? rating;
  final double size;

  @override
  Widget build(BuildContext context) {
    final v = rating ?? 0;
    return Semantics(
      label: rating == null ? 'No rating' : 'Rated ${rating!.toStringAsFixed(1)} out of 5',
      child: ExcludeSemantics(
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 1; i <= 5; i++) Icon(v >= i - 0.25 ? Icons.star_rounded : (v >= i - 0.75 ? Icons.star_half_rounded : Icons.star_outline_rounded), size: size, color: AppColors.gold),
        ]),
      ),
    );
  }
}

class RatingHeader extends StatelessWidget {
  const RatingHeader({super.key, required this.rating, this.unanswered});
  final Rating rating;
  final int? unanswered;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: rating.count == 0
            ? Text('No reviews yet. Customers can review a visit for 30 days after it is completed.', style: theme.textTheme.bodyMedium)
            : Row(children: [
                Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(rating.average?.toStringAsFixed(1) ?? '-', style: theme.textTheme.displaySmall),
                  Stars(rating: rating.average),
                  const SizedBox(height: AppSpacing.xs),
                  Text('${rating.count} ${rating.count == 1 ? 'review' : 'reviews'}', style: theme.textTheme.bodySmall),
                  if (unanswered != null && unanswered! > 0) Text('$unanswered to answer', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.warning)),
                ]),
                const SizedBox(width: AppSpacing.xl),
                Expanded(
                  child: Column(children: [
                    for (var s = 5; s >= 1; s--)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Semantics(
                          label: '$s stars: ${rating.distribution[s] ?? 0} reviews',
                          child: ExcludeSemantics(
                            child: Row(children: [
                              SizedBox(width: 14, child: Text('$s', style: theme.textTheme.bodySmall)),
                              const SizedBox(width: AppSpacing.sm),
                              Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: rating.share(s), minHeight: 8, color: AppColors.gold, backgroundColor: AppColors.sand))),
                            ]),
                          ),
                        ),
                      ),
                  ]),
                ),
              ]),
      ),
    );
  }
}

/// Small helper used by every list screen: loading, error and retry in one place.
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({super.key, required this.future, required this.builder, required this.onRetry, this.loadingLabel = 'Loading…'});
  final Future<T> future;
  final Widget Function(T data) builder;
  final VoidCallback onRetry;
  final String loadingLabel;

  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
        future: future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return LoadingView(label: loadingLabel);
          if (snap.hasError) {
            final e = snap.error;
            return ErrorView(message: e is ApiException ? e.message : 'Could not load this screen.', requestId: e is ApiException ? e.requestId : null, onRetry: onRetry);
          }
          return builder(snap.data as T);
        },
      );
}
