import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'review_api.dart';
import 'review_models.dart';
import 'review_widgets.dart';
import 'write_review_screen.dart';

/// "To review" (completed visits that can still be reviewed) and "My reviews" (written reviews, with the salon's response).
class MyReviewsScreen extends StatefulWidget {
  const MyReviewsScreen({super.key, required this.api});
  final ReviewApi api;

  @override
  State<MyReviewsScreen> createState() => _MyReviewsScreenState();
}

class _MyReviewsScreenState extends State<MyReviewsScreen> {
  late Future<List<PendingReview>> _pending = widget.api.pending();
  late Future<MyReviewsPage> _mine = widget.api.myReviews();

  void _reload() => setState(() {
        _pending = widget.api.pending();
        _mine = widget.api.myReviews();
      });

  Future<void> _open(Widget screen) async {
    final saved = await Navigator.push<bool>(context, MaterialPageRoute<bool>(builder: (_) => screen));
    if (saved == true && mounted) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(title: const Text('My reviews'), bottom: const TabBar(tabs: [Tab(text: 'To review'), Tab(text: 'Written')])),
        body: TabBarView(children: [
          _Load<List<PendingReview>>(
            future: _pending,
            onRetry: _reload,
            loadingLabel: 'Loading your visits…',
            builder: (items) => items.isEmpty
                ? const EmptyView(icon: Icons.rate_review_outlined, title: 'Nothing to review', message: 'After a visit is completed you can rate it here for 30 days.')
                : ListView.separated(
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    itemCount: items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                    itemBuilder: (_, i) => _PendingCard(item: items[i], onTap: () => _open(WriteReviewScreen.create(api: widget.api, pending: items[i]))),
                  ),
          ),
          _Load<MyReviewsPage>(
            future: _mine,
            onRetry: _reload,
            loadingLabel: 'Loading your reviews…',
            builder: (page) => page.items.isEmpty
                ? const EmptyView(icon: Icons.star_outline_rounded, title: 'No reviews yet', message: 'Reviews you write appear here.')
                : ListView.separated(
                    padding: const EdgeInsets.all(AppSpacing.lg),
                    itemCount: page.items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.md),
                    itemBuilder: (_, i) => _MyReviewCard(review: page.items[i], onEdit: () => _open(WriteReviewScreen.edit(api: widget.api, review: page.items[i]))),
                  ),
          ),
        ]),
      ),
    );
  }
}

class _Load<T> extends StatelessWidget {
  const _Load({required this.future, required this.builder, required this.onRetry, required this.loadingLabel});
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
            return ErrorView(message: e is ApiException ? e.message : 'Could not load this list.', requestId: e is ApiException ? e.requestId : null, onRetry: onRetry);
          }
          return RefreshIndicator(onRefresh: () async => onRetry(), child: builder(snap.data as T));
        },
      );
}

class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.item, required this.onTap});
  final PendingReview item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.all(AppSpacing.lg),
        title: Text(item.salonName, style: theme.textTheme.titleMedium),
        subtitle: Text('${reviewDate(item.visitAt)} · ${item.staffName}\n${item.services.map((s) => s.name).join(', ')}${item.reviewBefore == null ? '' : '\nReview before ${reviewDate(item.reviewBefore)}'}'),
        isThreeLine: true,
        trailing: const Icon(Icons.chevron_right),
      ),
    );
  }
}

class _MyReviewCard extends StatelessWidget {
  const _MyReviewCard({required this.review, required this.onEdit});
  final MyReview review;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(review.salonName, style: theme.textTheme.titleMedium, overflow: TextOverflow.ellipsis)),
            Text(reviewDate(review.createdAt) + (review.edited ? ' · edited' : ''), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ]),
          const SizedBox(height: AppSpacing.xs),
          StarRow(rating: review.rating.toDouble()),
          if (review.comment != null) ...[const SizedBox(height: AppSpacing.sm), Text(review.comment!)],
          if (review.isHidden) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(color: AppColors.danger.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(AppRadius.input)),
              child: Text('This review was hidden by our team${review.hiddenReason == null ? '.' : ': ${review.hiddenReason}'}', style: theme.textTheme.bodyMedium),
            ),
          ],
          if (review.response != null) ...[
            const SizedBox(height: AppSpacing.md),
            Text('Response from the salon', style: theme.textTheme.labelMedium),
            Text(review.response!.text),
          ],
          if (review.canEdit) ...[
            const SizedBox(height: AppSpacing.sm),
            Align(alignment: Alignment.centerRight, child: TextButton.icon(onPressed: onEdit, icon: const Icon(Icons.edit_outlined, size: 18), label: const Text('Edit'))),
          ],
        ]),
      ),
    );
  }
}
