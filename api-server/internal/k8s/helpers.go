package k8s

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PodToNodeExported wraps the unexported podToNode for handlers.
func PodToNodeExported(pod *corev1.Pod) *TopologyNode {
	return podToNode(pod)
}

func listOpts() metav1.ListOptions {
	return metav1.ListOptions{}
}

func getOpts() metav1.GetOptions {
	return metav1.GetOptions{}
}
